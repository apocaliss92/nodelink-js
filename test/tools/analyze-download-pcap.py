#!/usr/bin/env python3
"""
Analyze PCAP for TrackMix PoE (192.168.50.226) download flow - full analysis
"""

import subprocess
import struct
import sys

PCAP_FILE = "pcap/host 192.168.50.226 and tcp port 9000_DOWNLOAD.pcapng"
CAMERA_IP = "192.168.50.226"

# Baichuan constants
CMD_NAMES = {
    1: "LOGIN",
    3: "VIDEO",
    5: "FILE_INFO_LIST_REPLAY",
    13: "FILE_INFO_LIST_DOWNLOAD",
    44: "SERIAL",
    58: "GET_ABILITY",
    151: "GET_DEVICE_INFO",
    319: "GET_TIMELAPSE_CFG",
}

def extract_header(payload):
    """Extract Baichuan header from TCP payload"""
    # Look for magic pattern 0xf0debc0a (little endian for 0x0abcdef0)
    magic1 = bytes([0xf0, 0xde, 0xbc, 0x0a])
    magic2 = bytes([0xab, 0xcd, 0xef, 0x00])
    
    idx = -1
    for m in [magic1, magic2]:
        try:
            idx = payload.index(m)
            break
        except ValueError:
            continue
    
    if idx < 0 or len(payload) < idx + 20:
        return None, -1
    
    header = payload[idx:idx+20]
    # Format: magic(4) + cmdId(4) + payloadLen(4) + channelId(1) + streamType(1) + msgNum(2) + messageClass(2) + ? (2)
    
    cmdId = struct.unpack('<I', header[4:8])[0]
    payloadLen = struct.unpack('<I', header[8:12])[0]
    channelId = header[12]
    streamType = header[13]
    msgNum = struct.unpack('<H', header[14:16])[0]
    messageClass = struct.unpack('<H', header[18:20])[0]
    
    return {
        'cmdId': cmdId,
        'payloadLen': payloadLen,
        'channelId': channelId,
        'streamType': streamType, 
        'msgNum': msgNum,
        'messageClass': messageClass,
    }, idx

def main():
    print("=== TrackMix PoE (192.168.50.226) Download PCAP Analysis ===")
    print()
    
    # Extract all TCP payloads with direction
    result = subprocess.run([
        'tshark', '-r', PCAP_FILE,
        '-T', 'fields',
        '-e', 'frame.number',
        '-e', 'ip.src',
        '-e', 'ip.dst', 
        '-e', 'tcp.payload',
        '-Y', 'tcp.payload and tcp.len > 0'
    ], capture_output=True, text=True)
    
    interesting_cmds = []
    
    for line in result.stdout.strip().split('\n')[:200]:  # First 200 frames
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 4:
            continue
            
        frame_num, src_ip, dst_ip, payload_hex = parts
        
        # Determine direction
        if dst_ip == CAMERA_IP:
            direction = "TX"
        else:
            direction = "RX"
        
        try:
            payload = bytes.fromhex(payload_hex.replace(':', ''))
        except:
            continue
            
        header, idx = extract_header(payload)
        if header:
            cmd_name = CMD_NAMES.get(header['cmdId'], f"cmd{header['cmdId']}")
            print(f"Frame {frame_num:>5} [{direction}]: {cmd_name:25} cmdId={header['cmdId']:>3}, ch={header['channelId']:>2}, payloadLen={header['payloadLen']:>6}")
            
            # Se è un comando interessante, salva per analisi
            if header['cmdId'] in [5, 13, 319, 3]:
                xml_data = payload[idx+20:idx+20+min(header['payloadLen'], 500)]
                interesting_cmds.append({
                    'frame': frame_num,
                    'dir': direction,
                    'cmdId': header['cmdId'],
                    'cmd_name': cmd_name,
                    'payload': xml_data
                })
    
    print("\n=== Interesting Command Payloads ===")
    for cmd in interesting_cmds[:20]:
        print(f"\nFrame {cmd['frame']} [{cmd['dir']}] {cmd['cmd_name']}:")
        try:
            text = cmd['payload'].decode('utf-8', errors='replace')
            print(f"  {text[:300]}")
        except:
            print(f"  {cmd['payload'][:100]}")

if __name__ == '__main__':
    main()
