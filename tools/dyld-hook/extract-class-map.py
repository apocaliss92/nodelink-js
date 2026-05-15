#!/usr/bin/env python3
"""
Recursive TLV parser that walks every parseAIData input in the hook log,
locates every `04 0a 00` box, captures the (type1, type2) parent tuple at the
node where it sits, and cross-references with the class index the SDK assigned.

Produces the static (type1, type2) → class index map that the SDK has hard-
coded in `s_tlv_types_map`, derived purely from runtime observation. Once we
have this map we can decode class labels from raw additionalHeader bytes
without any further SDK calls.

Each box's class in BC_AI_DATA is determined by the parent path in the TLV
tree, exactly as the disassembly of __analysisExtenTLV does:
   level 0 (top):    type1=0,  type2=0
   level 1 (outer):  type1=Touter, type2=0
   level 2 (mid):    type1=Touter, type2=Tmid
   level 3 (inner):  lookup s_tlv_types_map[type1][type2][type]

The box TLV is type=04; the SDK only writes it into a class array when the
(type1, type2, type=4) tuple resolves to a valid action_code in the map. We
just need to capture which tuples actually fired for which class.
"""
import re
import sys
from collections import defaultdict

LOG_PATH = sys.argv[1] if len(sys.argv) > 1 else "/tmp/aimark-hook.log"

# ---- TLV walker -----------------------------------------------------------

def walk_tlv(buf, start, end, type1=0, type2=0, depth=0, max_depth=16):
    """
    Yield (offset, type1, type2, current_type, length, payload_start) for every
    TLV record encountered while recursively walking the buffer between
    `start` and `end`.

    The SDK promotes type1/type2 only at the first two depth levels (mirroring
    the OUTER_ZERO and MIDDLE_ZERO branches in __analysisExtenTLV). Once both
    type1 and type2 are set, the dispatch is a static-map lookup, and the
    parser may keep recursing into nested action TLVs — but every nested
    `04 0a 00` it encounters still uses the (type1, type2) of its innermost
    set-context. We replicate that by keeping (type1, type2) frozen at depth
    >= 2 while continuing to walk the structure.
    """
    if depth > max_depth:
        return
    pos = start
    while pos + 3 <= end:
        t = buf[pos]
        if t == 0:  # the SDK treats type=0 as end-of-stream
            return
        length = buf[pos + 1] | (buf[pos + 2] << 8)
        record_end = pos + 3 + length
        if record_end > end:
            return
        yield (pos, type1, type2, t, length, pos + 3)
        # Determine next (type1, type2) for the recursion.
        next_t1, next_t2 = type1, type2
        if type1 == 0:
            next_t1 = t
        elif type2 == 0:
            next_t2 = t
        # Don't descend into the box's own 10-byte coordinate payload; the
        # bytes inside are u16 values, not TLVs.
        if length > 0 and not (t == 0x04 and length == 10):
            yield from walk_tlv(buf, pos + 3, record_end, next_t1, next_t2, depth + 1, max_depth)
        pos = record_end


# ---- Parse hook log -------------------------------------------------------

samples = []
cur = {"hex": None, "classes": []}
with open(LOG_PATH) as f:
    for line in f:
        if "=== parseAIData" in line:
            if cur.get("hex") and cur.get("classes"):
                samples.append(cur)
            cur = {"hex": None, "classes": []}
        m = re.search(r"input\((\d+)B\):\s+([0-9a-f]+)", line)
        if m:
            cur["size"] = int(m.group(1))
            cur["hex"] = m.group(2)
        m = re.search(
            r"view(\d+) class(\d+)\s+(\d+)x(\d+)\s+boxes=(\d+):\s+(.*)",
            line,
        )
        if m:
            cur["classes"].append({
                "view": int(m.group(1)),
                "class": int(m.group(2)),
            })
if cur.get("hex") and cur.get("classes"):
    samples.append(cur)

print(f"Parsed {len(samples)} box-bearing samples")

# ---- Cross-reference ------------------------------------------------------

# For each sample, find the (type1, type2) tuple at each `04 0a 00` box TLV
# (where the box has length=10) and pair with the reported class index. The
# SDK assigns at most one class index per parseAIData call (we never saw
# multiple distinct classes in the same call in our captures), so we use
# classes[0]["class"] as the ground truth.
tuple_to_class_count = defaultdict(lambda: defaultdict(int))

for s in samples:
    buf = bytes.fromhex(s["hex"])
    # First locate the outer TLV. Marker `ff XX 00 01 0b 00 01 08`:
    #   buf[0] = 0xff
    #   buf[1..2] = outer length u16-LE
    if len(buf) < 8 or buf[0] != 0xff:
        continue
    # The outer TLV is at offset 0; payload starts at offset 3 inside the
    # standard block. Walk recursively from the OUTER level.
    cls = s["classes"][0]["class"]
    seen_tuples = set()
    for off, t1, t2, t, length, _ in walk_tlv(buf, 0, len(buf)):
        if t == 0x04 and length == 10 and t1 != 0 and t2 != 0:
            seen_tuples.add((t1, t2))
    for tup in seen_tuples:
        tuple_to_class_count[tup][cls] += 1

print(f"\nFound (type1, type2) → class mappings:")
for tup in sorted(tuple_to_class_count.keys()):
    counts = tuple_to_class_count[tup]
    total = sum(counts.values())
    classes_str = ", ".join(f"class{c}={n}" for c, n in sorted(counts.items()))
    print(f"  ({hex(tup[0])}, {hex(tup[1])}):  {classes_str}  (total {total})")
