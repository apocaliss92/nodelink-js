#!/usr/bin/env python3

from __future__ import annotations

from pathlib import Path
import argparse


def find_any(d: bytes, needles: list[tuple[str, bytes]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for name, needle in needles:
        out[name] = d.find(needle)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "glob",
        nargs="?",
        default="host-192.168.1.161_cmd298.rsp_ch53_st0_msg0.aesdec.body.binonly.bin.*.bin",
        help="Glob relativo a pcap/reports/dec/ per selezionare i candidati (default: cmd298 rsp_ch53).",
    )
    ap.add_argument(
        "--max",
        type=int,
        default=65536,
        help="Considera interessanti solo firme entro questo offset (default: 65536).",
    )
    args = ap.parse_args()

    base = Path("pcap/reports/dec")
    if not base.exists():
        raise SystemExit("missing pcap/reports/dec")

    needles = [
        ("jpg", b"\xff\xd8\xff"),
        ("png", b"\x89PNG\r\n\x1a\n"),
        ("ftyp", b"ftyp"),
        ("moov", b"moov"),
        ("moof", b"moof"),
        ("mdat", b"mdat"),
        ("annexb", b"\x00\x00\x00\x01"),
        ("lz4f", b"\x04\x22\x4d\x18"),
    ]

    files = sorted(base.glob(args.glob))
    print(f"found {len(files)} candidates")

    for p in files:
        d = p.read_bytes()
        hits = find_any(d, needles)
        interesting = {k: v for k, v in hits.items() if v != -1 and v < args.max}
        if interesting:
            print(p.name)
            for k, v in sorted(interesting.items(), key=lambda kv: kv[1]):
                print(f"  {k:7} {v}")


if __name__ == "__main__":
    main()
