#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
from pathlib import Path

import lief


def inspect_elf(path: Path) -> dict:
    bin = lief.parse(str(path))
    if bin is None:
        return {"path": str(path), "error": "parse_failed"}

    if not isinstance(bin, lief.ELF.Binary):
        return {"path": str(path), "error": f"not_elf:{type(bin)}"}

    raw = None
    try:
        raw = path.read_bytes()
    except Exception:
        raw = None

    dyn = bin.dynamic_entries
    needed = [e.name for e in dyn if isinstance(e, lief.ELF.DynamicEntryLibrary)]

    # imported functions (best-effort; many are stripped)
    imported = []
    try:
        for f in bin.imported_functions:
            # LIEF may return Function objects depending on version
            if isinstance(f, str):
                imported.append(f)
            else:
                imported.append(getattr(f, "name", None) or str(f))
    except Exception:
        pass

    # dynamic symbols (names might be empty if stripped)
    dynsyms = []
    try:
        for s in bin.dynamic_symbols:
            n = s.name
            if n:
                dynsyms.append(n)
    except Exception:
        pass

    # relocations referencing symbols
    rel_syms = []
    try:
        for r in bin.relocations:
            if r.has_symbol and r.symbol is not None and r.symbol.name:
                rel_syms.append(r.symbol.name)
    except Exception:
        pass

    def uniq(seq):
        out = []
        seen = set()
        for x in seq:
            if x in seen:
                continue
            seen.add(x)
            out.append(x)
        return out

    def find_symbol(name: str):
        try:
            s = bin.get_symbol(name)
            if s is not None and getattr(s, "value", 0):
                return s
        except Exception:
            pass

        # fallback: scan dynamic + regular symbols
        try:
            for s in getattr(bin, "dynamic_symbols", []) or []:
                if getattr(s, "name", None) == name:
                    return s
        except Exception:
            pass

        try:
            for s in getattr(bin, "symbols", []) or []:
                if getattr(s, "name", None) == name:
                    return s
        except Exception:
            pass

        return None

    def symbol_section_meta(sym):
        try:
            sec = getattr(sym, "section", None)
            if sec is None:
                return None
            sec_type = getattr(sec, "type", None)
            sec_type_str = str(sec_type) if sec_type is not None else None
            return {
                "name": getattr(sec, "name", None),
                "type": sec_type_str,
                "size": int(getattr(sec, "size", 0) or 0),
                "virtual_address": int(getattr(sec, "virtual_address", 0) or 0),
                "offset": int(getattr(sec, "offset", 0) or 0),
            }
        except Exception:
            return None

    def bytes_at_va(va: int, n: int):
        # Prefer LIEF helper when present.
        try:
            data = bin.get_content_from_virtual_address(va, n)
            if data is not None:
                b = bytes(data)
                if len(b) == n:
                    return b
        except Exception:
            pass

        if raw is None:
            return None
        try:
            off = bin.virtual_address_to_offset(va)
            if off < 0 or off + n > len(raw):
                return None
            return raw[off : off + n]
        except Exception:
            return None

    extracted_symbols = {}
    for spec in getattr(inspect_elf, "_extract_specs", []) or []:
        name, n = spec
        s = find_symbol(name)
        if s is None:
            extracted_symbols[name] = {"ok": False, "reason": "symbol_not_found"}
            continue

        va = int(getattr(s, "value", 0) or 0)
        size = int(getattr(s, "size", 0) or 0)
        sec_meta = symbol_section_meta(s)

        # If symbol points to NOBITS (e.g., .bss), the file has no initial bytes.
        if sec_meta and sec_meta.get("type") and "NOBITS" in str(sec_meta.get("type")):
            extracted_symbols[name] = {
                "ok": False,
                "reason": "in_bss",
                "va": va,
                "size": size,
                "section": sec_meta,
            }
            continue

        want = n
        if want <= 0:
            want = size if size > 0 else 0
        elif size > 0 and want > size:
            want = size
        if want <= 0:
            extracted_symbols[name] = {
                "ok": False,
                "reason": "unknown_len",
                "va": va,
                "size": size,
                "section": sec_meta,
            }
            continue

        b = bytes_at_va(va, want)
        if b is None or len(b) != want:
            extracted_symbols[name] = {
                "ok": False,
                "reason": "read_failed",
                "va": va,
                "size": size,
                "len": want,
                "section": sec_meta,
            }
            continue

        extracted_symbols[name] = {
            "ok": True,
            "va": va,
            "size": size,
            "len": want,
            "hex": b.hex(),
            "section": sec_meta,
        }

    return {
        "path": str(path),
        "architecture": str(bin.header.machine_type),
        "is_pie": bool(bin.is_pie),
        "has_symbols": bool(getattr(bin, "has_symbols", False)),
        "needed": needed,
        "imported_functions": uniq(imported),
        "dynamic_symbol_names": uniq(dynsyms),
        "relocation_symbol_names": uniq(rel_syms),
        "extracted_symbols": extracted_symbols,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("so", nargs="+", help="ELF .so paths")
    ap.add_argument("--out", default="pcap/reports/apk/elf-inspect.json")
    ap.add_argument(
        "--extract-symbol",
        action="append",
        default=[],
        help="Extract bytes from a symbol: NAME[:LEN]. If LEN omitted/0, uses symbol size (if known).",
    )
    args = ap.parse_args()

    extract_specs = []
    for s in args.extract_symbol:
        if not s:
            continue
        if ":" in s:
            name, ln = s.split(":", 1)
            try:
                n = int(ln, 10)
            except Exception:
                n = 0
        else:
            name, n = s, 0

        name = name.strip()
        if not name:
            continue
        extract_specs.append((name, n))

    inspect_elf._extract_specs = extract_specs  # type: ignore[attr-defined]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    report = [inspect_elf(Path(p)) for p in args.so]
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True))
    print(str(out_path))


if __name__ == "__main__":
    main()
