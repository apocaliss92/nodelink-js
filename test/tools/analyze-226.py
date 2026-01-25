import struct

# All TX frames from PCAP - first 20 bytes (header only)
frames_hex = [
    ("4", "f0debc0a01000000000000000000000012dc1465"),
    ("16", "f0debc0a970000009a0000000100000000001464"),
    ("18", "f0debc0a3a0000006a00000002000000000014646a"),
    ("32", "f0debc0a2c000000680000000c00000000001464"),
    ("50", "f0debc0a03000000af00000010000000000014640000"),
    ("101", "f0debc0a3f0100006800000011000000000014646800"),
]

print("=== TrackMix PoE (192.168.50.226) Download PCAP Analysis ===\n")
for frame_num, hex_data in frames_hex:
    buf = bytes.fromhex(hex_data[:40])  # First 20 bytes only
    cmdId = struct.unpack_from('<I', buf, 4)[0]
    payloadLen = struct.unpack_from('<I', buf, 8)[0]
    channelId = buf[12]
    streamType = buf[13]
    msgNum = struct.unpack_from('<H', buf, 14)[0]
    messageClass = struct.unpack_from('<H', buf, 18)[0]
    print(f"Frame {frame_num}: cmdId={cmdId} (0x{cmdId:x}), ch={channelId}, st={streamType}, msg={msgNum}, class=0x{messageClass:x}, payloadLen={payloadLen}")
