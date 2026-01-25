#!/usr/bin/env python3
"""Analyze new TrackMix download PCAP"""
import subprocess
import struct

PCAP_FILE = '/Users/gianlucaruocco/Documents/Git/reolink-baichuan-js/pcap/192.168.50.226 DOWNLOAD.pcapng'
CAMERA_IP = '192.168.50.226'

CMD_NAMES = {
    1: 'LOGIN', 3: 'VIDEO', 5: 'FILE_INFO_LIST_REPLAY', 13: 'FILE_INFO_LIST_DOWNLOAD',
    44: 'SERIAL', 58: 'GET_ABILITY', 78: 'PREVIEW', 80: 'TALK', 102: 'GET_DEVICESETTINGS',
    104: 'GET_OSD', 146: 'GET_ABILITY_RESP', 151: 'GET_DEVICE_INFO', 192: 'TALK_RESP',
    199: 'GET_AIDETECTION', 299: 'GET_DAYNIGHT', 319: 'GET_TIMELAPSE_CFG',
}

def parse_frames():
    result = subprocess.run([
        'tshark', '-r', PCAP_FILE, '-T', 'fields',
        '-e', 'frame.number', '-e', 'ip.src', '-e', 'ip.dst', '-e', 'tcp.payload',
        '-Y', 'tcp.payload and tcp.len > 0'
    ], capture_output=True, text=True)
    
    print(f"=== TrackMix Download PCAP Analysis ===\n")
    print(f"File: {PCAP_FILE}\n")
    
    interesting = []
    
    for line in result.stdout.strip().split('\n')[:300]:
        if not line: continue
        parts = line.split('\t')
        if len(parts) < 4: continue
        frame_num, src_ip, dst_ip, payload_hex = parts
        direction = 'TX' if dst_ip == CAMERA_IP else 'RX'
        
        try:
            payload = bytes.fromhex(payload_hex.replace(':', ''))
        except: continue
        
        # Find Baichuan magic
        magic = bytes([0xf0, 0xde, 0xbc, 0x0a])
        try:
            idx = payload.index(magic)
        except: continue
        
        if len(payload) < idx + 20: continue
        header = payload[idx:idx+20]
        cmdId = struct.unpack('<I', header[4:8])[0]
        payloadLen = struct.unpack('<I', header[8:12])[0]
        channelId = header[12]
        streamType = header[13]
        msgNum = struct.unpack('<H', header[14:16])[0]
        
        cmd_name = CMD_NAMES.get(cmdId, f'cmd{cmdId}')
        print(f'Frame {frame_num:>5} [{direction}]: {cmd_name:25} cmdId={cmdId:>3}, ch={channelId:>2}, st={streamType}, msg={msgNum:>3}, payloadLen={payloadLen:>6}')
        
        # Collect interesting commands
        if cmdId in [5, 13, 14, 15, 16, 272, 273, 274]:
            xml_payload = payload[idx+20:idx+20+min(payloadLen, 1000)]
            interesting.append({
                'frame': frame_num,
                'dir': direction,
                'cmdId': cmdId,
                'cmd_name': cmd_name,
                'channelId': channelId,
                'payload': xml_payload,
                'payloadLen': payloadLen
            })
    
    print("\n=== Interesting Command Payloads ===")
    for cmd in interesting[:30]:
        print(f"\nFrame {cmd['frame']} [{cmd['dir']}] {cmd['cmd_name']} ch={cmd['channelId']} len={cmd['payloadLen']}:")
        try:
            # Try to decode as UTF-8 XML
            text = cmd['payload'].decode('utf-8', errors='replace')
            # Check if it looks like XML
            if '<' in text:
                print(f"  {text[:500]}")
            else:
                print(f"  (binary data, first 50 bytes hex): {cmd['payload'][:50].hex()}")
        except:
            print(f"  (binary): {cmd['payload'][:50].hex()}")

if __name__ == '__main__':
    parse_frames()
