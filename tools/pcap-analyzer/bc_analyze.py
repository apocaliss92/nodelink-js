#!/usr/bin/env python3
"""
Baichuan Protocol PCAP Analyzer

Comprehensive analysis of Reolink Baichuan protocol traffic from PCAP/PCAPNG files.
Uses scapy for reliable TCP stream reassembly.

Usage:
    python3 bc_analyze.py <pcap_file> [options]

Options:
    --password PWD    Password for AES decryption
    --camera IP       Filter by camera IP
    --cmdId ID        Filter by command ID
    --verbose         Show packet details
    --xml             Show decrypted XML payloads

Requires: scapy, pycryptodome
    pip install scapy pycryptodome
"""

from scapy.all import rdpcap, TCP, IP
import struct
import sys
import hashlib
import argparse

# Baichuan protocol constants
MAGIC = 0x0ABCDEF0
BC_XOR_KEY = bytes([0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff])
BC_AES_IV = b'0123456789abcdef'

# Header classes
CLASS_20 = 0x6514  # 20-byte header
CLASS_24 = 0x6414  # 24-byte header
CLASS_20_ALT = 0x6614  # 20-byte header (alternate)

# Common command names
CMD_NAMES = {
    1: 'Login',
    2: 'Logout',
    3: 'Preview',
    4: 'PreviewStop',
    5: 'FileInfoList_Replay',
    6: 'FileInfoList_Stop',
    10: 'Talk',
    13: 'FileDownload',
    14: 'FileDownloadStop',
    16: 'GetAbility',
    31: 'FileInfoList',
    33: 'SystemGeneral',
    35: 'ConfigGet',
    36: 'ConfigSet',
    78: 'AlarmPush',
    80: 'DevInfo',
    93: 'NetPort',
    109: 'Snapshot',
    146: 'HddInfo',
    192: 'AudioCfg',
    250: 'StreamInfo',
    286: 'PlaybackSeek',
    298: 'CoverPreview',
    302: 'FloodlightCfg',
}

def get_cmd_name(cmd_id):
    return CMD_NAMES.get(cmd_id, f'Unknown_{cmd_id}')

def bc_xor(data, offset):
    """BC XOR decrypt/encrypt (symmetric)"""
    off = offset & 0xff
    result = bytearray(len(data))
    for i in range(len(data)):
        key = BC_XOR_KEY[(off + i) % len(BC_XOR_KEY)]
        result[i] = data[i] ^ key ^ off
    return bytes(result)

def derive_aes_key(nonce, password):
    """Derive AES key from nonce and password"""
    combined = f"{nonce}-{password}"
    md5 = hashlib.md5(combined.encode('utf-8')).hexdigest().upper()
    return md5[:16].encode('utf-8')

def aes_decrypt(data, key):
    """AES-128-CFB decrypt"""
    if len(data) == 0:
        return b''
    try:
        from Crypto.Cipher import AES
        cipher = AES.new(key, AES.MODE_CFB, iv=BC_AES_IV, segment_size=128)
        return cipher.decrypt(data)
    except ImportError:
        print("Warning: pycryptodome not installed, AES decryption unavailable")
        return data

def try_decrypt_body(data, channel_id, nonce=None, password=None):
    """Try to decrypt body using BC-XOR or AES"""
    if len(data) == 0:
        return data, 'empty'
    
    # Try BC-XOR first
    xor_result = bc_xor(data, channel_id)
    if looks_like_xml(xor_result):
        return xor_result, 'xor'
    
    # Try AES if nonce and password provided
    if nonce and password:
        key = derive_aes_key(nonce, password)
        aes_result = aes_decrypt(data, key)
        if looks_like_xml(aes_result):
            return aes_result, 'aes'
    
    # Return original if no decryption worked
    return data, 'unknown'

def looks_like_xml(data):
    """Check if data looks like XML"""
    if len(data) < 5:
        return False
    try:
        text = data.decode('utf-8', errors='ignore').strip()
        return text.startswith('<?xml') or text.startswith('<')
    except:
        return False

def parse_baichuan_frames(data, direction):
    """Parse Baichuan frames from TCP stream data"""
    frames = []
    pos = 0
    
    while pos + 20 <= len(data):
        # Find magic
        magic = struct.unpack('<I', data[pos:pos+4])[0]
        if magic != MAGIC:
            pos += 1
            continue
        
        # Parse header
        cmd_id = struct.unpack('<I', data[pos+4:pos+8])[0]
        body_len = struct.unpack('<I', data[pos+8:pos+12])[0]
        channel_id = data[pos+12]
        stream_type = data[pos+13]
        msg_num = struct.unpack('<H', data[pos+14:pos+16])[0]
        response_code = struct.unpack('<H', data[pos+16:pos+18])[0]
        msg_class = struct.unpack('<H', data[pos+18:pos+20])[0]
        
        # Determine header size
        if msg_class == CLASS_24:
            header_len = 24
            payload_offset = struct.unpack('<I', data[pos+20:pos+24])[0] if pos + 24 <= len(data) else 0
        elif msg_class in (CLASS_20, CLASS_20_ALT):
            header_len = 20
            payload_offset = 0
        else:
            pos += 1
            continue
        
        # Validate body_len
        if body_len > 10_000_000 or pos + header_len + body_len > len(data):
            pos += 1
            continue
        
        # Extract body
        body = data[pos+header_len:pos+header_len+body_len]
        
        frames.append({
            'cmd_id': cmd_id,
            'cmd_name': get_cmd_name(cmd_id),
            'body_len': body_len,
            'channel_id': channel_id,
            'stream_type': stream_type,
            'msg_num': msg_num,
            'response_code': response_code,
            'msg_class': hex(msg_class),
            'payload_offset': payload_offset,
            'direction': direction,
            'body': body,
        })
        
        pos += header_len + body_len
    
    return frames

def analyze_pcap(pcap_file, args):
    """Analyze PCAP file"""
    print(f"Analyzing: {pcap_file}")
    packets = rdpcap(pcap_file)
    print(f"Loaded {len(packets)} packets")
    
    # Build TCP streams
    streams = {}
    for pkt in packets:
        if not pkt.haslayer(TCP) or not pkt.haslayer(IP):
            continue
        tcp = pkt[TCP]
        ip = pkt[IP]
        if not tcp.payload:
            continue
        
        # Filter by camera IP if specified
        if args.camera:
            if ip.src != args.camera and ip.dst != args.camera:
                continue
        
        key = (ip.src, ip.dst, tcp.sport, tcp.dport)
        if key not in streams:
            streams[key] = b''
        streams[key] += bytes(tcp.payload)
    
    print(f"Found {len(streams)} TCP streams")
    
    # Parse frames from streams
    all_frames = []
    nonce = None
    
    for key, data in streams.items():
        src, dst, sport, dport = key
        if dport != 9000 and sport != 9000:
            continue
        
        direction = "REQ" if dport == 9000 else "RSP"
        frames = parse_baichuan_frames(data, direction)
        
        # Try to extract nonce from login response (code 56594 = challenge with nonce)
        for frame in frames:
            if frame['cmd_id'] == 1 and frame['direction'] == 'RSP':
                # Try to decrypt and find nonce (can be in 56594 challenge or 200 success)
                decrypted, method = try_decrypt_body(frame['body'], frame['channel_id'])
                if b'<nonce>' in decrypted:
                    try:
                        start = decrypted.index(b'<nonce>') + 7
                        end = decrypted.index(b'</nonce>')
                        nonce = decrypted[start:end].decode('utf-8')
                        print(f"Found nonce: {nonce}")
                    except:
                        pass
        
        all_frames.extend(frames)
    
    # Filter by cmdId if specified
    if args.cmdId:
        all_frames = [f for f in all_frames if f['cmd_id'] == args.cmdId]
    
    # Print summary
    print(f"\nTotal frames: {len(all_frames)}")
    
    # Count by cmdId
    cmd_counts = {}
    for frame in all_frames:
        key = f"{frame['cmd_id']:3d}-{frame['direction']}"
        cmd_counts[key] = cmd_counts.get(key, 0) + 1
    
    print("\nCommand ID counts:")
    for k in sorted(cmd_counts.keys(), key=lambda x: int(x.split('-')[0])):
        cmd_id = int(k.split('-')[0])
        print(f"  {k} ({get_cmd_name(cmd_id)}): {cmd_counts[k]}")
    
    # Show details if verbose
    if args.verbose or args.xml:
        print("\n" + "="*60)
        for i, frame in enumerate(all_frames):
            print(f"\nFrame {i+1}: {frame['direction']} cmdId={frame['cmd_id']} ({frame['cmd_name']})")
            print(f"  channelId={frame['channel_id']} msgNum={frame['msg_num']} responseCode={frame['response_code']}")
            print(f"  bodyLen={frame['body_len']} msgClass={frame['msg_class']} payloadOffset={frame['payload_offset']}")
            
            if args.xml and frame['body']:
                decrypted, method = try_decrypt_body(
                    frame['body'], 
                    frame['channel_id'],
                    nonce,
                    args.password
                )
                if looks_like_xml(decrypted):
                    try:
                        xml_text = decrypted.decode('utf-8', errors='ignore')
                        print(f"  XML ({method}):")
                        for line in xml_text.split('\n')[:20]:  # Limit lines
                            print(f"    {line}")
                    except:
                        pass

def main():
    parser = argparse.ArgumentParser(description='Baichuan Protocol PCAP Analyzer')
    parser.add_argument('pcap_file', help='PCAP/PCAPNG file to analyze')
    parser.add_argument('--password', help='Password for AES decryption')
    parser.add_argument('--camera', help='Filter by camera IP')
    parser.add_argument('--cmdId', type=int, help='Filter by command ID')
    parser.add_argument('--verbose', action='store_true', help='Show packet details')
    parser.add_argument('--xml', action='store_true', help='Show decrypted XML payloads')
    
    args = parser.parse_args()
    analyze_pcap(args.pcap_file, args)

if __name__ == '__main__':
    main()
