#!/usr/bin/env python3
"""Analyze alternate download PCAP"""
import subprocess
import struct

PCAP_FILE = 'pcap/host 192.168.50.226 _DOWNLOAD.pcapng'
CAMERA_IP = '192.168.50.226'

CMD_NAMES = {
    1: 'LOGIN', 3: 'VIDEO', 5: 'FILE_INFO_LIST_REPLAY', 13: 'FILE_INFO_LIST_DOWNLOAD',
    44: 'SERIAL', 58: 'GET_ABILITY', 151: 'GET_DEVICE_INFO', 319: 'GET_TIMELAPSE_CFG',
}

result = subprocess.run([
    'tshark', '-r', PCAP_FILE, '-T', 'fields',
    '-e', 'frame.number', '-e', 'ip.src', '-e', 'ip.dst', '-e', 'tcp.payload',
    '-Y', 'tcp.payload and tcp.len > 0'
], capture_output=True, text=True)

for line in result.stdout.strip().split('\n')[:200]:
    if not line: continue
    parts = line.split('\t')
    if len(parts) < 4: continue
    frame_num, src_ip, dst_ip, payload_hex = parts
    direction = 'TX' if dst_ip == CAMERA_IP else 'RX'
    try:
        payload = bytes.fromhex(payload_hex.replace(':', ''))
    except: continue
    magic = bytes([0xf0, 0xde, 0xbc, 0x0a])
    try:
        idx = payload.index(magic)
    except: continue
    if len(payload) < idx + 20: continue
    header = payload[idx:idx+20]
    cmdId = struct.unpack('<I', header[4:8])[0]
    payloadLen = struct.unpack('<I', header[8:12])[0]
    channelId = header[12]
    cmd_name = CMD_NAMES.get(cmdId, f'cmd{cmdId}')
    print(f'Frame {frame_num:>5} [{direction}]: {cmd_name:25} cmdId={cmdId:>3}, ch={channelId:>2}, payloadLen={payloadLen:>6}')
