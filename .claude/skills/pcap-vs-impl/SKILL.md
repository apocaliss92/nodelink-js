---
name: pcap-vs-impl
description: Compare a Baichuan TCP capture against the library's current cmd_id handlers — flag unknown commands, missing parsers, and bodies whose shape doesn't match what the code expects. Invoke when the user shares a `.pcapng` from the in-app Capture tool (or any tshark capture filtered to a Reolink camera) and wants to know which protocol gaps to fix next.
---

# Compare pcap to library implementation

This skill turns a Baichuan-protocol pcap capture into a triage report you
can act on:

1. Which cmd_ids did we see, and which ones do we already handle?
2. Which unknown cmd_ids are showing up — what's a good first guess at
   their meaning based on body shape, frequency, and direction?
3. For known cmd_ids, does the body decrypt to XML that our parser would
   actually accept? (best-effort, requires the camera credentials to be
   configured in the in-app settings or passed via env vars)

## When to invoke

- User shares a `.pcapng` from the Capture page or any tshark capture
- User asks "what new commands does this camera use?", "which features
  are we missing?", or "is our parser correct for cmd_id X?"
- After adding a new camera model and wanting to know what extra protocol
  features it exposes

## How to run

The skill expects a path to a pcap file as the only argument. The agent
should:

1. Validate the file exists and is a pcap-ng (`file <path>`).
2. Run the analysis script:

   ```bash
   npx tsx .claude/skills/pcap-vs-impl/scripts/compare.ts <path> \
     [--username <user>] [--password <pwd>] [--out <markdown-path>]
   ```

   - `--username` / `--password` are optional. When provided, the script
     decrypts every body using the nonce that's already in the pcap.
     The credentials are not stored anywhere; they're only used to
     derive the AES key in-process.
   - `--out` writes the markdown report to a file. By default it streams
     to stdout.

3. Read the report, extract the most useful actions, and present a short
   summary to the user. Highlight:
   - Unknown cmd_ids with body shape (XML root element, length, frequency)
   - Known cmd_ids whose body XML doesn't have the fields our parser reads
   - Push events (msgNum=0) with non-empty bodies — usually new
     state-notification commands worth wiring into events-manager

4. Suggest concrete next steps: which file to edit (`src/protocol/constants.ts`
   for new constants, `src/reolink/baichuan/utils/<area>.ts` for the
   parser, `app/src/routers/baichuan.ts` for the tRPC procedure) and
   whether a fixture is worth adding to `test/fixtures/protocol/`.

## What the script does

- Spawns tshark to extract every TCP payload to/from port 9000, in order.
- Feeds the payloads (one parser per direction) into
  `BaichuanFrameParser` from `@apocaliss92/nodelink-js`.
- For each frame: header (cmd_id, msg_num, response_code, message_class,
  payload_offset, body_len) + redacted body preview.
- If credentials are provided, finds the encryption-info response
  (`cmd_id=1, responseCode=0xDDxx`), extracts the nonce, derives the AES
  key, and decrypts every subsequent body. Login bodies remain redacted
  — the script never echoes the credentials it received.
- Maps each cmd_id to the source location that handles it (best-effort
  ripgrep against `src/protocol/constants.ts` for the constant name and
  `src/reolink/baichuan/utils/` for the parser).
- Emits markdown with three sections: known/unknown cmd_id summary,
  per-cmd_id body samples, and a short "TODO" list of probable gaps.

## Output sections

The markdown report has, in order:

1. **Summary**: total frames, distinct cmd_ids, decrypted percentage,
   capture duration.
2. **Known cmd_ids**: table with handler file, count, and a sample body
   snippet (decrypted XML root, or hex prefix when not decryptable).
3. **Unknown cmd_ids**: triage table — same shape but with extra
   guess columns (likely XML / binary / push event).
4. **Suggested actions**: bulleted list of files to add or update, in
   priority order.

## Privacy

The script reads the pcap locally, never uploads anywhere. Credentials
passed via `--password` are kept in process memory only and never echoed
in the output. The report intentionally omits IP addresses; if you want
the camera/local IP for debugging open the pcap in Wireshark instead.
