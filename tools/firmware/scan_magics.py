#!/usr/bin/env python3
"""Lightweight firmware magic scanner.

Usage:
  python3 tools/firmware/scan_magics.py path/to/firmware.pak

It scans for common embedded-firmware signatures (UBI/UBIFS/SquashFS/uImage/FDT)
and prints offsets + (for UBI#) the most common stride.

No external dependencies.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Pattern:
    name: str
    needle: bytes


PATTERNS: list[Pattern] = [
    Pattern("UBI# (UBI EC header)", b"UBI#"),
    Pattern("UBIFS (superblock)", b"UBIFS"),
    Pattern("hsqs (SquashFS)", b"hsqs"),
    Pattern("uImage (legacy)", b"\x27\x05\x19\x56"),
    Pattern("FDT (device tree)", b"\xd0\x0d\xfe\xed"),
]


def iter_hits(path: Path, needle: bytes, *, chunk_size: int = 8 * 1024 * 1024):
    overlap = max(0, len(needle) - 1)
    offset = 0
    tail = b""
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            data = tail + chunk

            start = 0
            while True:
                idx = data.find(needle, start)
                if idx == -1:
                    break
                yield offset - len(tail) + idx
                start = idx + 1

            if overlap:
                tail = data[-overlap:]
            else:
                tail = b""
            offset += len(chunk)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", type=Path)
    ap.add_argument("--max", dest="max_hits", type=int, default=200, help="max hits printed per pattern")
    args = ap.parse_args()

    path: Path = args.path
    if not path.exists():
        raise SystemExit(f"not found: {path}")

    print(f"File: {path}")
    print(f"Size: {path.stat().st_size} bytes")

    all_hits: dict[str, list[int]] = {}
    for pat in PATTERNS:
        hits = []
        for i, off in enumerate(iter_hits(path, pat.needle)):
            if i < args.max_hits:
                hits.append(off)
        all_hits[pat.name] = hits

        count = sum(1 for _ in iter_hits(path, pat.needle))
        if count == 0:
            continue
        print(f"\n== {pat.name} ==")
        print(f"count: {count}")
        if hits:
            print("first:", " ".join(hex(x) for x in hits[:10]))
            print("min:", hex(min(hits)), "max:", hex(max(hits)))
            if count > args.max_hits:
                print(f"(printed first {args.max_hits})")

    # UBI stride heuristic
    ubi_hits = list(iter_hits(path, b"UBI#"))
    if len(ubi_hits) >= 3:
        deltas = [b - a for a, b in zip(ubi_hits, ubi_hits[1:])]
        common = Counter(deltas).most_common(5)
        print("\n== UBI stride (heuristic) ==")
        for d, c in common:
            print(f"delta {d} (0x{d:x}) -> {c} hits")
        best_delta, _ = common[0]
        print("first UBI#:", hex(ubi_hits[0]))
        print("suggested UBI start offset:", hex(ubi_hits[0]), "(use -s/--start-offset)")
        print("PEB size candidate:", best_delta, f"(0x{best_delta:x})")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
