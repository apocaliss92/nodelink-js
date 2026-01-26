# Baichuan PCAP Analyzer Tools

A suite of tools for analyzing Reolink Baichuan protocol traffic from PCAP files.

## Overview

These tools help reverse-engineer and debug the Baichuan protocol by:

- Extracting session nonces for AES key derivation
- Parsing and cataloging packets by cmdId
- Decrypting XML payloads
- Filtering by session/connection
- Generating human-readable reports

## Tools

### Core Tools (JavaScript/Node.js)

| Tool                    | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `bc-protocol.mjs`       | Protocol constants and utilities (shared module)     |
| `bc-pcap-parse.mjs`     | Main parser - extracts all Baichuan frames from PCAP |
| `bc-nonce-extract.mjs`  | Find login nonce from a session                      |
| `bc-session-filter.mjs` | Filter packets by session (IP/port pair)             |
| `bc-decrypt-xml.mjs`    | Decrypt XML payloads given nonce + password          |
| `bc-catalog.mjs`        | Catalog packets by cmdId with statistics             |
| `bc-report.mjs`         | Generate full analysis report                        |

### Quick Analysis (Python)

| Tool             | Description                            |
| ---------------- | -------------------------------------- |
| `quick_cmdid.py` | Quick cmdId count analysis using scapy |

## Requirements

```bash
# For JavaScript tools - no external deps, uses built-in modules

# For Python tools
pip install scapy
```

## Usage Examples

## Usage Examples

### Quick cmdId count (Python, recommended for PCAPNG)

```bash
python3 tools/pcap-analyzer/quick_cmdid.py pcap/capture.pcapng
```

### Full analysis with XML decryption (Python)

```bash
python3 tools/pcap-analyzer/bc_analyze.py pcap/capture.pcapng --password "MyPassword" --xml
```

### Filter by command ID

```bash
python3 tools/pcap-analyzer/bc_analyze.py pcap/capture.pcapng --cmdId 298 --verbose
```

### Filter by camera IP

```bash
python3 tools/pcap-analyzer/bc_analyze.py pcap/capture.pcapng --camera 192.168.1.170
```

## Protocol Reference

### Baichuan Header Structure

| Offset | Size | Field         | Description                                   |
| ------ | ---- | ------------- | --------------------------------------------- |
| 0      | 4    | Magic         | `0x0ABCDEF0` (LE)                             |
| 4      | 4    | cmdId         | Command identifier                            |
| 8      | 4    | bodyLen       | Payload length                                |
| 12     | 1    | channelId     | Channel/session ID                            |
| 13     | 1    | streamType    | Stream type                                   |
| 14     | 2    | msgNum        | Message sequence number                       |
| 16     | 2    | responseCode  | Response status (200=OK, 400=Error)           |
| 18     | 2    | messageClass  | Header class (0x6414=24-byte, 0x6514=20-byte) |
| 20     | 4    | payloadOffset | Extension XML length (24-byte header only)    |

### Encryption Types

- **BC XOR**: Key `[0x1f, 0x2d, 0x3c, 0x4b, 0x5a, 0x69, 0x78, 0xff]`, formula: `output[i] = input[i] ^ key[(off+i)%8] ^ off`
- **AES-128-CFB**: IV = `"0123456789abcdef"`, Key = `MD5(nonce + "-" + password).slice(0,16).toUpperCase()`

### Common cmdIds

| cmdId | Name                | Description          |
| ----- | ------------------- | -------------------- |
| 1     | Login               | Authentication       |
| 3     | Preview             | Live stream          |
| 5     | FileInfoList Replay | Recording playback   |
| 13    | File Download       | Direct file download |
| 31    | FileInfoList        | Recording search     |
| 78    | Alarm Push          | Motion events        |
| 109   | Snapshot            | JPEG capture         |
| 298   | CoverPreview        | Recording thumbnail  |

## Notes

- **PCAPNG Support**: The Python tools (`bc_analyze.py`, `quick_cmdid.py`) use scapy which supports both PCAP and PCAPNG formats.
- **JavaScript Tools**: The `.mjs` tools are kept for reference but may need PCAP format (not PCAPNG). Convert with: `editcap -F pcap input.pcapng output.pcap`
- **AES Decryption**: Requires the nonce from login response and the password to derive the AES key.
