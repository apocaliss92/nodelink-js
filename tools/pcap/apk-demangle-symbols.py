#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from cxxfilt import demangle


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--elf-report", default="pcap/reports/apk/elf-inspect.json")
    ap.add_argument("--so-endswith", default="libBCSDKWrapper.so")
    ap.add_argument(
        "--keywords",
        default="BaichuanEncryptor,BCNetSession,NetSessionSeed,bootSecret,BCSDK_GetBootSecret,netXmlEncryption,DownloadSession,Cover,TLV,mp4,LZ4",
        help="Comma-separated keywords to keep (regex OR is used)",
    )
    ap.add_argument("--out", default="pcap/reports/apk/demangled.symbols.txt")
    args = ap.parse_args()

    report_path = Path(args.elf_report)
    data = json.loads(report_path.read_text())

    entry = None
    for e in data:
        if str(e.get("path", "")).endswith(args.so_endswith):
            entry = e
            break
    if entry is None:
        raise SystemExit(f"No entry ending with {args.so_endswith} in {report_path}")

    kw = [k.strip() for k in args.keywords.split(",") if k.strip()]
    rx = re.compile("|".join(re.escape(k) for k in kw), re.IGNORECASE)

    syms = set(entry.get("dynamic_symbol_names", []) or []) | set(entry.get("relocation_symbol_names", []) or [])
    keep = sorted([s for s in syms if rx.search(s)])

    out_lines = []
    out_lines.append(f"source: {report_path}")
    out_lines.append(f"library: {entry.get('path')}")
    out_lines.append(f"keywords: {', '.join(kw)}")
    out_lines.append(f"matches: {len(keep)}")
    out_lines.append("")

    for s in keep:
        if s.startswith("_Z"):
            try:
                out_lines.append(f"{s}\n  -> {demangle(s)}")
                continue
            except Exception:
                pass
        out_lines.append(s)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(out_lines) + "\n")
    print(str(out_path))


if __name__ == "__main__":
    main()
