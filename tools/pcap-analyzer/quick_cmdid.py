#!/usr/bin/env python3
"""
Quick cmdId analysis - Baichuan protocol packet counter

Usage:
    python3 quick_cmdid.py <pcap_file>

Counts Baichuan protocol command IDs from PCAP/PCAPNG files.
Requires: scapy (pip install scapy)
"""
from scapy.all import rdpcap, TCP, IP
import struct
import sys

MAGIC = 0x0ABCDEF0

# Header structure (from framing.ts):
# 0-3: magic (4 bytes)
# 4-7: cmdId (4 bytes)
# 8-11: bodyLen (4 bytes)
# 12: channelId (1 byte)
# 13: streamType (1 byte)
# 14-15: msgNum (2 bytes)
# 16-17: responseCode (2 bytes)
# 18-19: messageClass (2 bytes)
# 20-23: payloadOffset (4 bytes, only for 24-byte headers)

pcap_file = sys.argv[1] if len(sys.argv) > 1 else 'pcap/192.168.1.170 only_covers_loading.pcapng'

print(f"Analyzing: {pcap_file}")
packets = rdpcap(pcap_file)
print(f"Loaded {len(packets)} packets")

streams = {}
for pkt in packets:
    if not pkt.haslayer(TCP) or not pkt.haslayer(IP):
        continue
    tcp = pkt[TCP]
    ip = pkt[IP]
    if not tcp.payload:
        continue
    key = (ip.src, ip.dst, tcp.sport, tcp.dport)
    if key not in streams:
        streams[key] = b''
    streams[key] += bytes(tcp.payload)

print(f"Found {len(streams)} TCP streams")

cmd_counts = {}
response_codes = {}

for key, data in streams.items():
    src, dst, sport, dport = key
    if dport != 9000 and sport != 9000:
        continue
    
    direction = "REQ" if dport == 9000 else "RSP"
    pos = 0
    
    while pos + 20 <= len(data):
        magic = struct.unpack('<I', data[pos:pos+4])[0]
        if magic != MAGIC:
            pos += 1
            continue
        
        cmd_id = struct.unpack('<I', data[pos+4:pos+8])[0]
        body_len = struct.unpack('<I', data[pos+8:pos+12])[0]
        channel_id = data[pos+12]
        stream_type = data[pos+13]
        msg_num = struct.unpack('<H', data[pos+14:pos+16])[0]
        response_code = struct.unpack('<H', data[pos+16:pos+18])[0]
        msg_class = struct.unpack('<H', data[pos+18:pos+20])[0]
        
        if msg_class == 0x6414:
            header_len = 24
        elif msg_class in (0x6514, 0x6614):
            header_len = 20
        else:
            # Unknown class, skip
            pos += 1
            continue
        
        key_str = f"{cmd_id:3d}-{direction}"
        cmd_counts[key_str] = cmd_counts.get(key_str, 0) + 1
        
        # Track response codes for responses
        if direction == "RSP" and response_code != 0:
            rc_key = f"{cmd_id}:{response_code}"
            response_codes[rc_key] = response_codes.get(rc_key, 0) + 1
        
        # Validate body_len to avoid infinite loops
        if body_len > 10_000_000:
            pos += 1
            continue
            
        pos += header_len + body_len

print("\nCommand ID counts:")
for k in sorted(cmd_counts.keys(), key=lambda x: int(x.split('-')[0])):
    print(f"  {k}: {cmd_counts[k]}")

if response_codes:
    print("\nNon-zero response codes:")
    for k in sorted(response_codes.keys()):
        print(f"  cmdId:{k} count={response_codes[k]}")
