#!/usr/bin/env python3

import math
import collections
from pathlib import Path


def entropy(b: bytes) -> float:
    if not b:
        return 0.0
    n = len(b)
    counts = collections.Counter(b)
    return -sum((v / n) * math.log2(v / n) for v in counts.values())


def show(label: str, path: str, limit: int = 65536) -> None:
    p = Path(path)
    data = p.read_bytes()
    head16 = data[:16].hex()
    print(f"{label:28} len={len(data):9} H64k={entropy(data[:limit]):.4f} head16={head16}")


def main() -> None:
    paths = [
        ("cmd298.payload", "pcap/reports/extracts/host-192.168.1.161_cmd298.payload.bin"),
        ("cmd298.aesdec.payload", "pcap/reports/extracts/host-192.168.1.161_cmd298.aesdec.payload.bin"),
        ("cmd298.aesdec.body.binonly", "pcap/reports/extracts/host-192.168.1.161_cmd298.aesdec.body.binonly.bin"),
        ("cmd298.aesdec.body", "pcap/reports/extracts/host-192.168.1.161_cmd298.aesdec.body.bin"),
        ("cmd143.payload", "pcap/reports/extracts/host-192.168.1.161_cmd143.payload.bin"),
        ("cmd143.aesdec.payload", "pcap/reports/extracts/host-192.168.1.161_cmd143.aesdec.payload.bin"),
        (
            "cmd143_ch49.afterBody.aesdec",
            "pcap/reports/extracts/host-192.168.1.161_cmd143_ch49_st3.aesdec.payload.afterBody.bin",
        ),
    ]

    for label, path in paths:
        try:
            show(label, path)
        except FileNotFoundError:
            print(f"{label:28} MISSING {path}")


if __name__ == "__main__":
    main()
