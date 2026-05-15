#!/usr/bin/env python3
"""Cross-reference SDK hook log inputs with raw additionalHeader bytes from pcap."""
import re
import sys
import subprocess
import json

LOG_PATH = "/tmp/aimark-hook.log"
BOX_TLV_PREFIX = bytes.fromhex("040a00")  # TLV type=04, length=10

def parse_calls(log_path):
    """Yield (size, hex_input, list_of_boxes) per parseAIData call."""
    cur_input = None
    cur_size = None
    cur_boxes = []
    cur_return = None
    with open(log_path) as f:
        for line in f:
            line = line.rstrip("\n")
            if line.startswith("=== parseAIData"):
                if cur_input is not None:
                    yield (cur_size, cur_input, cur_boxes, cur_return)
                cur_input = None
                cur_size = None
                cur_boxes = []
                cur_return = None
            elif "input(" in line:
                m = re.search(r"input\((\d+)B\):\s+([0-9a-f]+)", line)
                if m:
                    cur_size = int(m.group(1))
                    cur_input = m.group(2)
            elif "return=" in line:
                m = re.search(r"return=(-?\d+)", line)
                if m: cur_return = int(m.group(1))
            elif "boxes=" in line:
                # Pattern: view0 class1  896x480  boxes=1: [189,267,...]
                m = re.search(r"view(\d+) class(\d+)\s+(\d+)x(\d+)\s+boxes=(\d+):\s+(.*)", line)
                if m:
                    view, cls, w, h, n, payload = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4)), int(m.group(5)), m.group(6)
                    boxes = re.findall(r"\[([0-9,]+)\]", payload)
                    cur_boxes.append({"view": view, "class": cls, "w": w, "h": h, "n": n, "boxes": [list(map(int, b.split(","))) for b in boxes]})
    if cur_input is not None:
        yield (cur_size, cur_input, cur_boxes, cur_return)

def find_box_tlv(hex_str):
    """Find all occurrences of TLV(type=4, len=10) in hex string.
    Returns list of (offset_bytes, x1, y1, x2, y2, conf)."""
    b = bytes.fromhex(hex_str)
    results = []
    i = 0
    while i + 13 <= len(b):
        if b[i] == 0x04 and b[i+1] == 0x0a and b[i+2] == 0x00:
            # Parse 5 u16 LE starting at offset 3
            x1 = b[i+3] | (b[i+4] << 8)
            y1 = b[i+5] | (b[i+6] << 8)
            x2 = b[i+7] | (b[i+8] << 8)
            y2 = b[i+9] | (b[i+10] << 8)
            conf = b[i+11] | (b[i+12] << 8)
            results.append((i, x1, y1, x2, y2, conf))
        i += 1
    return results

calls = list(parse_calls(LOG_PATH))
print(f"Total parseAIData calls: {len(calls)}")

calls_with_boxes = [c for c in calls if c[2]]
print(f"Calls that produced boxes: {len(calls_with_boxes)}")

# Now scan ALL inputs for the box TLV signature
calls_with_tlv = []
for size, hex_input, boxes, rv in calls:
    if hex_input is None: continue
    tlvs = find_box_tlv(hex_input)
    if tlvs:
        calls_with_tlv.append((size, hex_input, boxes, tlvs))

print(f"Calls whose input contains '04 0a 00' TLV pattern: {len(calls_with_tlv)}")

# Show first 5 matches
print("\n=== First 5 input matches ===")
for size, hex_input, boxes, tlvs in calls_with_tlv[:5]:
    print(f"\nsize={size}B, found {len(tlvs)} box TLV(s):")
    for off, x1, y1, x2, y2, conf in tlvs:
        print(f"  offset 0x{off:x}: x1={x1}, y1={y1}, x2={x2}, y2={y2}, conf={conf}  -> w={x2-x1}, h={y2-y1}")
    if boxes:
        print(f"  SDK output:")
        for v in boxes:
            print(f"    view{v['view']} class{v['class']} {v['w']}x{v['h']}: {v['boxes']}")

# Now check: do calls with boxes always have the TLV pattern? (sanity check)
print("\n=== Sanity check: calls with boxes that DON'T have 04 0a 00 pattern ===")
unmatched = 0
for size, hex_input, boxes, rv in calls_with_boxes:
    tlvs = find_box_tlv(hex_input)
    if not tlvs:
        unmatched += 1
        if unmatched <= 3:
            print(f"  size={size}B output has boxes but no 04 0a 00 TLV: {hex_input[:80]}...")
            for v in boxes:
                print(f"    expected: view{v['view']} class{v['class']}: {v['boxes']}")
print(f"  Total unmatched: {unmatched}/{len(calls_with_boxes)}")
