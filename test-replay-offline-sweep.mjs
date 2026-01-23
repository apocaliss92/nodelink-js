#!/usr/bin/env node
/**
 * Offline sweep runner.
 *
 * Uses the `bcmedia_chunk_*.bin` dumps and iterates multiple `REPLAY_H264_FORCE_MODE` values,
 * scoring each by ffmpeg decode error count.
 *
 * Env:
 * - DUMP_DIR (default test/artifacts/replay-ext-debug)
 * - OUT_DIR (default test/artifacts/replay-offline-sweep)
 * - MAX_MODES (default 30) number of modes to scan (set 0 or 'all' for all)
 * - KEEP_TOP (default 5) how many results to print/save as "top"
 * - SCAN_ALL (default false) scan all unique modes for coverage, ignoring MAX_MODES
 * - FFMPEG_TOP (default 25) run ffmpeg scoring only on top-N by coverage
 */

import { BaichuanVideoStream } from "./dist/index.js";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function pickStartAckJson(dumpDir) {
  const files = readdirSync(dumpDir).filter((f) => f.startsWith("replay_start_ack_msgNum_") && f.endsWith(".json"));
  if (files.length === 0) return null;
  files.sort();
  return join(dumpDir, files[files.length - 1]);
}

function stableStringify(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}

function shortHash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function parseNdjsonModes(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Map();
  for (const l of lines) {
    try {
      const obj = JSON.parse(l);
      const mode = obj?.mode;
      if (!mode || typeof mode !== "object") continue;
      // Ensure required keys exist (force-mode expects these fields)
      const normalized = {
        scope: mode.scope,
        reset: mode.reset,
        algo: mode.algo,
        key: mode.key,
        iv: mode.iv,
        offsetMode: mode.offsetMode,
        offset: mode.offset,
        innerSkip: mode.innerSkip ?? 0,
      };
      const k = JSON.stringify(normalized);
      if (!seen.has(k)) {
        seen.set(k, { mode: normalized, maxScore: Number(obj?.score ?? 0) });
      } else {
        const cur = seen.get(k);
        cur.maxScore = Math.max(cur.maxScore, Number(obj?.score ?? 0));
      }
    } catch {
      // ignore
    }
  }
  return Array.from(seen.values()).sort((a, b) => (b.maxScore ?? 0) - (a.maxScore ?? 0));
}

async function decodeDumpToH264({ dumpDir, outBase, forceModeJson }) {
  // Load replay keys/session material if present
  let sessionKey16 = null;
  try {
    const keys = readJson(join(dumpDir, "replay_keys.json"));
    if (keys?.sessionKeyHex) sessionKey16 = Buffer.from(String(keys.sessionKeyHex), "hex");
  } catch {
    // ignore
  }

  // Load start-ack tail32 (ack_a/ack_b) if present
  let ackTail32 = null;
  try {
    const startAckPath = pickStartAckJson(dumpDir);
    if (startAckPath) {
      const ack = readJson(startAckPath);
      if (ack?.bodyTailHex) ackTail32 = Buffer.from(String(ack.bodyTailHex), "hex");
    }
  } catch {
    // ignore
  }

  class FakeClient extends EventEmitter {
    constructor() {
      super();
      this.enc = {
        kind: "none",
        ...(sessionKey16 && sessionKey16.length === 16 ? { key: sessionKey16 } : {}),
      };
    }
    getDebugConfig() {
      return {
        general: false,
        debugRtsp: false,
        traceNativeStream: false,
        dumpEnabled: false,
        dumpDir: "",
        dumpBcMedia: false,
        dumpNals: false,
      };
    }
    getTransport() {
      return "tcp";
    }
    tryDecryptBinary(buf) {
      return buf;
    }
  }

  const chunkFiles = readdirSync(dumpDir)
    .filter((f) => /^bcmedia_chunk_\d{4}\.bin$/.test(f))
    .sort();

  const client = new FakeClient();
  const stream = new BaichuanVideoStream({
    client,
    api: undefined,
    channel: 0,
    profile: "main",
    variant: "default",
    cmdId: 5,
    acceptAnyStreamType: true,
  });

  if (ackTail32 && ackTail32.length >= 32) stream.setReplayStartAckTail32(ackTail32);

  const aus = [];
  let totalBytes = 0;
  let keyframes = 0;
  let minUs = null;
  let maxUs = null;

  stream.on("videoAccessUnit", ({ data, isKeyframe, microseconds }) => {
    aus.push({ data, microseconds: microseconds ?? null });
    totalBytes += data.length;
    if (isKeyframe) keyframes++;
    if (typeof microseconds === "number") {
      if (minUs == null || microseconds < minUs) minUs = microseconds;
      if (maxUs == null || microseconds > maxUs) maxUs = microseconds;
    }
  });

  const prevForce = process.env.REPLAY_H264_FORCE_MODE;
  if (forceModeJson && String(forceModeJson).trim().length > 0) {
    process.env.REPLAY_H264_FORCE_MODE = forceModeJson;
  } else {
    delete process.env.REPLAY_H264_FORCE_MODE;
  }
  try {
    await stream.start();
    const msgNum = 11;
    const channelId = 1;
    const streamType = 0;

    for (const f of chunkFiles) {
      const payload = readFileSync(join(dumpDir, f));
      const frame = {
        header: {
          magic: Buffer.alloc(4),
          cmdId: 5,
          bodyLen: payload.length,
          channelId,
          streamType,
          msgNum,
          responseCode: 0,
          messageClass: 0,
        },
        body: payload,
        extension: Buffer.alloc(0),
        payload,
        messageKey: 0,
        raw: payload,
      };
      client.emit("push", frame);
    }
    await stream.stop();
  } finally {
    if (prevForce == null) delete process.env.REPLAY_H264_FORCE_MODE;
    else process.env.REPLAY_H264_FORCE_MODE = prevForce;
  }

  const H264_AUD = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x09, 0xf0]);
  const allData = Buffer.concat(aus.flatMap((c) => (c?.data ? [H264_AUD, c.data] : [])));
  const outH264 = `${outBase}.h264`;
  writeFileSync(outH264, allData);

  let derivedFps = null;
  let spanSec = null;
  if (minUs != null && maxUs != null && maxUs > minUs && aus.length > 1) {
    spanSec = (maxUs - minUs) / 1_000_000;
    derivedFps = (aus.length - 1) / spanSec;
  }

  return { outH264, aus: aus.length, keyframes, totalBytes, derivedFps, spanSec };
}

function scoreByFfmpegErrors({ h264Path, derivedFps }) {
  const inputFps = derivedFps && Number.isFinite(derivedFps) && derivedFps > 0 ? derivedFps : 25;
  const inputFpsStr = Number.isFinite(inputFps) ? inputFps.toFixed(3) : "25";

  // Decode to null output and count error lines.
  // -v error prints only errors; this makes scoring stable and small.
  let out = "";
  try {
    out = execSync(
      `ffmpeg -hide_banner -v error -fflags +genpts -r ${inputFpsStr} -f h264 -i "${h264Path}" -f null - 2>&1`,
      { encoding: "utf8" },
    );
  } catch (e) {
    out = String(e?.stdout || "") + "\n" + String(e?.stderr || "") + "\n" + String(e?.message || "");
  }
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return { errorLines: lines.length, tail: lines.slice(-10).join("\n") };
}

async function main() {
  const dumpDir = (process.env.DUMP_DIR ?? "test/artifacts/replay-ext-debug").trim();
  const outDir = (process.env.OUT_DIR ?? "test/artifacts/replay-offline-sweep").trim();
  const rawMaxModes = process.env.MAX_MODES ?? "30";
  const maxModes = String(rawMaxModes).toLowerCase() === "all" ? 0 : Number(rawMaxModes);
  const keepTop = Number(process.env.KEEP_TOP ?? 5);
  const scanAll = String(process.env.SCAN_ALL ?? "false").toLowerCase() === "true";
  const ffmpegTop = Number(process.env.FFMPEG_TOP ?? 25);

  mkdirSync(outDir, { recursive: true });

  const choicePath = join(dumpDir, "replay_h264_choice.ndjson");
  let candidates = [];
  try {
    candidates = parseNdjsonModes(choicePath);
  } catch {
    // ignore
  }

  if (candidates.length === 0) {
    throw new Error(`No modes found in ${choicePath}. Re-run online once with dump enabled.`);
  }

  // Baseline (no forced mode): used to avoid selecting a mode that "wins" only by dropping most frames.
  console.log("\nComputing baseline (no forced mode)...");
  const baselineOutBase = join(outDir, "baseline_auto");
  const baselineDecoded = await decodeDumpToH264({ dumpDir, outBase: baselineOutBase, forceModeJson: "" });
  const baselineScore = scoreByFfmpegErrors({ h264Path: baselineDecoded.outH264, derivedFps: baselineDecoded.derivedFps });
  const baselineAus = Math.max(1, baselineDecoded.aus);
  console.log(
    `Baseline: AUs=${baselineDecoded.aus} keyframes=${baselineDecoded.keyframes} span=${baselineDecoded.spanSec?.toFixed?.(3) ?? "?"}s ` +
      `fps=${baselineDecoded.derivedFps?.toFixed?.(3) ?? "?"} ffmpegErrors=${baselineScore.errorLines}`,
  );

  const scanCount = scanAll || !Number.isFinite(maxModes) || maxModes <= 0 ? candidates.length : Math.min(candidates.length, maxModes);
  console.log(`Loaded ${candidates.length} unique modes; scanning ${scanCount}.`);

  // Phase 1: scan coverage (fast) for many/all modes.
  const coverageOnly = [];
  for (let i = 0; i < scanCount; i++) {
    const { mode, maxScore } = candidates[i];
    const modeJson = stableStringify(mode);
    const id = shortHash(modeJson);
    const outBase = join(outDir, `scan_${String(i + 1).padStart(3, "0")}_${id}`);

    const decoded = await decodeDumpToH264({ dumpDir, outBase, forceModeJson: modeJson });
    const coverage = decoded.aus / baselineAus;
    coverageOnly.push({
      idx: i + 1,
      id,
      mode,
      heurScore: maxScore,
      aus: decoded.aus,
      keyframes: decoded.keyframes,
      spanSec: decoded.spanSec,
      fps: decoded.derivedFps,
      coverage,
      h264: decoded.outH264,
    });

    if ((i + 1) % 10 === 0 || i === 0 || i + 1 === scanCount) {
      const bestCov = [...coverageOnly].sort((a, b) => b.coverage - a.coverage)[0];
      console.log(
        `[scan ${i + 1}/${scanCount}] last coverage=${(coverage * 100).toFixed(1)}% AUs=${decoded.aus} | best coverage=${(bestCov.coverage * 100).toFixed(1)}% idx=${bestCov.idx}`,
      );
    }
  }

  coverageOnly.sort((a, b) => b.coverage - a.coverage);
  const ffmpegCandidates = coverageOnly.slice(0, Math.max(1, ffmpegTop));
  console.log(
    `\nPhase 2: ffmpeg scoring top ${ffmpegCandidates.length} by coverage (best coverage=${(ffmpegCandidates[0].coverage * 100).toFixed(1)}%).`,
  );

  const results = [];
  for (let i = 0; i < ffmpegCandidates.length; i++) {
    const cand = ffmpegCandidates[i];
    const modeJson = stableStringify(cand.mode);
    const outBase = join(outDir, `mode_${String(i + 1).padStart(2, "0")}_${cand.id}`);

    console.log(`\n[${i + 1}/${ffmpegCandidates.length}] mode=${modeJson} (scanIdx=${cand.idx}, heurScore~${cand.heurScore})`);

    // Re-decode into a dedicated output name for the final report.
    const decoded = await decodeDumpToH264({ dumpDir, outBase, forceModeJson: modeJson });
    const score = scoreByFfmpegErrors({ h264Path: decoded.outH264, derivedFps: decoded.derivedFps });

    const coverage = decoded.aus / baselineAus;
    // Penalize low coverage heavily; we care about modes that keep the stream alive.
    // This avoids modes that emit 2-3 AUs and appear "good" by having few decoder errors.
    const coveragePenalty = Math.max(0, Math.round(1000 * (1 - coverage)));
    const objective = score.errorLines + coveragePenalty;

    const rec = {
      idx: cand.idx,
      id: cand.id,
      mode: cand.mode,
      heurScore: cand.heurScore,
      aus: decoded.aus,
      keyframes: decoded.keyframes,
      spanSec: decoded.spanSec,
      fps: decoded.derivedFps,
      errorLines: score.errorLines,
      coverage,
      objective,
      h264: decoded.outH264,
    };

    results.push(rec);
    results.sort((a, b) => a.objective - b.objective);

    const best = results[0];
    console.log(
      `AUs=${rec.aus} keyframes=${rec.keyframes} coverage=${(rec.coverage * 100).toFixed(1)}% ` +
        `span=${rec.spanSec?.toFixed?.(3) ?? "?"}s fps=${rec.fps?.toFixed?.(3) ?? "?"} ` +
        `ffmpegErrors=${rec.errorLines} objective=${rec.objective}`,
    );
    console.log(
      `Best so far: objective=${best.objective} (errors=${best.errorLines}, coverage=${(best.coverage * 100).toFixed(1)}%) id=${best.id} idx=${best.idx}`,
    );
  }

  results.sort((a, b) => a.objective - b.objective);
  const top = results.slice(0, Math.max(1, keepTop));
  const outSummary = join(outDir, "summary.json");
  writeFileSync(
    outSummary,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dumpDir,
        baseline: {
          aus: baselineDecoded.aus,
          keyframes: baselineDecoded.keyframes,
          spanSec: baselineDecoded.spanSec,
          fps: baselineDecoded.derivedFps,
          errorLines: baselineScore.errorLines,
          h264: baselineDecoded.outH264,
        },
        top,
        scanTopByCoverage: coverageOnly.slice(0, 50),
        allScored: results,
      },
      null,
      2,
    ),
  );

  console.log(`\nWrote ${outSummary}`);
  console.log("Top results:");
  for (const r of top) {
    console.log(
      `- objective=${r.objective} errors=${r.errorLines} aus=${r.aus} coverage=${(r.coverage * 100).toFixed(1)}% id=${r.id} idx=${r.idx} h264=${r.h264}`,
    );
    console.log(`  mode=${stableStringify(r.mode)}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.stack || err?.message || String(err));
  process.exit(1);
});
