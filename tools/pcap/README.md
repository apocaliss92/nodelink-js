# Baichuan pcap analyzer

Reverse-engineer Reolink Baichuan traffic captured on TCP port 9000.

Reuses the production crypto + framing modules (`src/protocol/`) so what you
see here is exactly what the library would produce on the wire.

## Requirements

- `tshark` (Wireshark CLI) on `$PATH`
- `npx tsx` (already in dev dependencies)
- A pcap that includes the login handshake (open the Reolink app *after*
  starting the capture)

## Quick start

```bash
# Header dump (no decryption needed)
npx tsx tools/pcap/analyzer.ts frames pcap/motion\ boxes.pcapng

# Show login negotiation: encType, nonce, resolved password
npx tsx tools/pcap/analyzer.ts login pcap/motion\ boxes.pcapng

# Group every observed cmd_id by frequency, with the friendly name
npx tsx tools/pcap/analyzer.ts groups pcap/motion\ boxes.pcapng

# Full decrypted XML, one block per frame
npx tsx tools/pcap/analyzer.ts analyze pcap/motion\ boxes.pcapng

# Drill into a specific cmd_id (e.g. AlarmEventList push)
npx tsx tools/pcap/analyzer.ts cmd 33 pcap/motion\ boxes.pcapng

# Dump every decrypted XML to disk for grep / diff workflows
npx tsx tools/pcap/analyzer.ts dump out/motion pcap/motion\ boxes.pcapng

# Shareable digest (no auth, no credentials) — paste into issues / PRs
npx tsx tools/pcap/analyzer.ts summary pcap/resolution\ .pcapng digest.txt
# Same, but also scrub IPs / MAC / serials
npx tsx tools/pcap/analyzer.ts summary pcap/resolution\ .pcapng digest.txt --strip-network
```

The `summary` command pairs each command's request and response in capture
order, drops the login/logout handshake entirely, and replaces every known
secret-bearing tag (`userName`, `password`, `nonce`, `token`, `serialNumber`,
`mac`, `<Encryption>…</Encryption>`) with `[REDACTED]`. With
`--strip-network` it also normalises IPs and MAC addresses so the resulting
file is safe to attach to a public issue.

## How it works

1. `tshark` extracts each TCP segment on port 9000 with stream id + direction.
2. `BaichuanFrameParser` reassembles those bytes into Baichuan frames
   (`f0 de bc 0a` magic, 20/24-byte header).
3. The first `cmd_id=1` frame with `responseCode=0xDDxx` is the server's
   negotiation reply; its low byte selects the post-login encryption (none /
   bc / aes / full_aes) and its `<nonce>` is the key seed.
4. Passwords are loaded from every `*_PASSWORD=` line in `.env`. The tool
   derives an AES key per candidate and picks the one that yields valid XML
   on subsequent frames.
5. Each frame is decrypted with the negotiated algorithm (bc XOR uses the
   header's `channelId` as the offset; AES uses the per-session key).

## Filters

| Flag | Effect |
|---|---|
| `--password X` | Force a single password (else: every `.env` candidate) |
| `--port N` | Use port `N` instead of 9000 |
| `--stream N` | Restrict to one `tcp.stream` index |
| `--dir c2s\|s2c` | One direction only |
| `--no-xml` | Header lines only |
| `--hex` | Append raw hex preview of the body |
| `--json` | JSON output (supported on `login` and `groups`) |

## Tips

- `groups` is the fastest way to spot interesting traffic. The cmd_id name
  comes from `src/protocol/constants.ts` so adding a constant there is
  immediately reflected in the analyzer output.
- For high-volume captures, narrow to a single stream first
  (`--stream 0`).
- Server pushes (camera-initiated frames) appear with `←` and usually have
  `msg#=0`.
