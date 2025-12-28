#!/usr/bin/env node
/**
 * Analizza i dump in test/frames-debug/bcmedia_chunk_*.bin e prova a ricostruire
 * la sequenza di pacchetti BCMedia esattamente come fa il runtime.
 *
 * Uso:
 *  1) BAICHUAN_DUMP_BCMEDIA=1 npm run test:tcp:video-stream-record
 *  2) npm run test:build && node dist/test/tcp/test-tcp-bcmedia-dump-analyze.js
 */
// @ts-expect-error - Path resolution at runtime
import { parseBcMedia, hasStartCodes, convertToAnnexB } from "../../index.js";
import * as fs from "node:fs";
import * as path from "node:path";

function listChunks(dir: string): string[] {
  const all = fs.readdirSync(dir);
  return all
    .filter((f) => f.startsWith("bcmedia_chunk_") && f.endsWith(".bin"))
    .sort()
    .map((f) => path.join(dir, f));
}

function h264NalTypesFromAnnexB(annexB: Buffer): number[] {
  const types: number[] = [];
  for (let i = 0; i < annexB.length - 4; i++) {
    // 00 00 01
    if (annexB[i] === 0x00 && annexB[i + 1] === 0x00 && annexB[i + 2] === 0x01 && i + 3 < annexB.length) {
      types.push((annexB[i + 3]! & 0x1f) >>> 0);
    }
    // 00 00 00 01
    if (
      annexB[i] === 0x00 &&
      annexB[i + 1] === 0x00 &&
      annexB[i + 2] === 0x00 &&
      annexB[i + 3] === 0x01 &&
      i + 4 < annexB.length
    ) {
      types.push((annexB[i + 4]! & 0x1f) >>> 0);
    }
  }
  return types.slice(0, 20);
}

async function main() {
  const dir = path.join(process.cwd(), "test", "frames-debug");
  if (!fs.existsSync(dir)) {
    console.error(`Directory non trovata: ${dir}`);
    process.exit(2);
  }

  const chunks = listChunks(dir);
  if (chunks.length === 0) {
    console.error(`Nessun chunk trovato in ${dir} (attesi bcmedia_chunk_*.bin)`);
    process.exit(2);
  }

  console.log(`Chunks: ${chunks.length}`);

  const counts = new Map<string, number>();
  let videoPackets = 0;
  let skipped = 0;
  let pframesDumped = 0;

  // Parser stream (neolink-style): concateniamo i chunk in un buffer e chiamiamo parseBcMedia in loop.
  let streamBuf = Buffer.alloc(0);
  const isMagicAt = (b: Buffer, i: number): boolean => {
    if (i + 4 > b.length) return false;
    const m = b.readUInt32LE(i);
    return (
      m === 0x31303031 ||
      m === 0x32303031 ||
      (m >= 0x63643030 && m <= 0x63643039) ||
      (m >= 0x63643130 && m <= 0x63643139) ||
      m === 0x62773530 ||
      m === 0x62773130
    );
  };

  for (const chunkPath of chunks) {
    const chunk = fs.readFileSync(chunkPath);
    streamBuf = streamBuf.length ? Buffer.concat([streamBuf, chunk]) : chunk;

    while (true) {
      const parsed = parseBcMedia(streamBuf);
      if (!parsed) {
        // resync: cerca prossimo magic e scarta 1 byte alla volta fino a trovarlo
        let found = -1;
        const maxScan = Math.min(streamBuf.length - 4, 128 * 1024);
        for (let i = 1; i <= maxScan; i++) {
          if (isMagicAt(streamBuf, i)) {
            found = i;
            break;
          }
        }
        if (found > 0) {
          skipped += found;
          streamBuf = streamBuf.subarray(found);
          continue;
        }
        break;
      }

      const { media, consumed } = parsed;
      const raw = streamBuf.subarray(0, consumed);
      streamBuf = streamBuf.subarray(consumed);

      counts.set(media.type, (counts.get(media.type) || 0) + 1);
      if (media.type === "Iframe" || media.type === "Pframe") {
        videoPackets++;
        const annexB = convertToAnnexB(media.data);
        const sc = hasStartCodes(annexB);
        const types = sc ? h264NalTypesFromAnnexB(annexB) : [];
        if (videoPackets <= 5) {
          console.log(
            `${media.type} len=${media.data.length} -> ${annexB.length} startCode=${sc} nalTypes=${types.join(",")}`
          );
        }

        // dump primi P-frame raw completi per analisi offline
        if (media.type === "Pframe" && pframesDumped < 2) {
          const out = path.join(dir, `pframe_raw_${pframesDumped}.bin`);
          fs.writeFileSync(out, raw);
          pframesDumped++;
        }
      }
    }
  }

  console.log("Counts:", Object.fromEntries(Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]))));
  console.log("Skipped bytes (resync):", skipped);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


