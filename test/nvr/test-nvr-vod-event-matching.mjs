import "dotenv/config";
import { ReolinkBaichuanApi } from "../../dist/index.js";

const host = process.env.NVR_HOST;
const username = process.env.NVR_USERNAME || "admin";
const password = process.env.NVR_PASSWORD;

if (host == null || host === "" || password == null || password === "") {
  throw new Error("Missing NVR_HOST/NVR_PASSWORD");
}

function parseChannels(v) {
  const raw = (v ?? "0").trim();
  const nums = raw
    .split(/[\s,]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
    .map((n) => Math.floor(n));
  return nums.length ? [...new Set(nums)] : [0];
}

function dayStartLocal(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function overlapMs(a, b) {
  const startMax = Math.max(a.startTimeMs, b.startTimeMs);
  const endMin = Math.min(a.endTimeMs, b.endTimeMs);
  return Math.max(0, endMin - startMax);
}

function detectOffsetBucketMs(events, clips) {
  const bucketSizeMs = 60_000;
  const maxAbsMs = 24 * 60 * 60 * 1000;
  const counts = new Map();

  for (const ev of events) {
    for (const c of clips) {
      const raw = (c.startTimeMs ?? 0) - (ev.startTimeMs ?? 0);
      const bucket = Math.round(raw / bucketSizeMs) * bucketSizeMs;
      if (!Number.isFinite(bucket) || Math.abs(bucket) > maxAbsMs) continue;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
    }
  }

  let bestBucket = 0;
  let bestCount = 0;
  for (const [bucket, count] of counts.entries()) {
    if (count > bestCount) {
      bestBucket = bucket;
      bestCount = count;
    }
  }

  return bestCount >= 2 ? bestBucket : 0;
}

function eventTokens(s) {
  if (!s) return [];
  return s
    .toLowerCase()
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function pickBestClipForEvent(ev, clips, offsetMs) {
  const shifted = {
    startTimeMs: (ev.startTimeMs ?? 0) + offsetMs,
    endTimeMs: (ev.endTimeMs ?? 0) + offsetMs,
  };

  let best = null;
  let bestOverlap = 0;
  for (const c of clips) {
    const ov = overlapMs(c, shifted);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = c;
    }
  }

  return { best, bestOverlap, shifted };
}

function checkFlags(ev, clip) {
  const fields = [
    "hasMotion",
    "hasPerson",
    "hasVehicle",
    "hasAnimal",
    "hasFace",
    "hasDoorbell",
    "hasPackage",
    "hasRf",
    "hasOther",
  ];

  const missing = [];
  for (const f of fields) {
    if (ev[f] === true && clip[f] !== true) missing.push(f);
  }
  return missing;
}

async function runWindow(label, start, end, channels, stream) {
  console.log("\n" + "=".repeat(100));
  console.log(`TEST: VOD<->EVENT matching (${label})`);
  console.log("=".repeat(100));
  console.log("start:", start.toString(), "|", start.toISOString());
  console.log("end  :", end.toString(), "|", end.toISOString());
  console.log("channels:", channels.join(", "), "stream:", stream);

  const api = new ReolinkBaichuanApi({ host, username, password, port: 9000 });
  await api.login();

  try {
    for (const channel of channels) {
      const clips = await api.listNvrRecordings({
        source: "baichuan",
        channel,
        start,
        end,
        streamType: stream,
        autoSearchByDay: true,
      });

      const events = await api.listNvrAlarmEventsEnrichedViaBaichuan({
        start,
        end,
        channels: [channel],
        streamType: stream === "sub" ? "subStream" : "mainStream",
      });

      const offsetMs = detectOffsetBucketMs(events, clips);

      let matchedEvents = 0;
      let unmatchedEvents = 0;
      let flagMismatches = 0;
      let recordTypeMismatches = 0;
      const samples = [];

      for (const ev of events) {
        const { best, bestOverlap, shifted } = pickBestClipForEvent(ev, clips, offsetMs);
        if (!best || bestOverlap <= 0) {
          unmatchedEvents++;
          if (samples.length < 10) {
            samples.push({
              kind: "UNMATCHED_EVENT",
              evRecordType: ev.recordType,
              evStart: new Date(ev.startTimeMs).toISOString(),
              evEnd: new Date(ev.endTimeMs).toISOString(),
              shiftedStart: new Date(shifted.startTimeMs).toISOString(),
              shiftedEnd: new Date(shifted.endTimeMs).toISOString(),
            });
          }
          continue;
        }

        matchedEvents++;

        const missingFlags = checkFlags(ev, best);
        if (missingFlags.length) {
          flagMismatches++;
          if (samples.length < 10) {
            samples.push({
              kind: "FLAG_MISMATCH",
              missingFlags,
              evRecordType: ev.recordType,
              clipRecordType: best.recordType,
              overlapMs: bestOverlap,
              clipFileName: best.fileName,
              clipStart: new Date(best.startTimeMs).toISOString(),
              clipEnd: new Date(best.endTimeMs).toISOString(),
              evStart: new Date(shifted.startTimeMs).toISOString(),
              evEnd: new Date(shifted.endTimeMs).toISOString(),
            });
          }
        }

        const evToks = eventTokens(ev.recordType);
        if (evToks.length) {
          const clipToks = eventTokens(best.recordType);
          const hasAnyTok = evToks.some((t) => clipToks.includes(t));
          if (!hasAnyTok) {
            recordTypeMismatches++;
            if (samples.length < 10) {
              samples.push({
                kind: "RECORDTYPE_MISMATCH",
                evRecordType: ev.recordType,
                clipRecordType: best.recordType,
                overlapMs: bestOverlap,
                clipFileName: best.fileName,
              });
            }
          }
        }
      }

      const clipsWithAnyEventLike = clips.filter((c) => {
        const rt = (c.recordType ?? "").toLowerCase();
        const hasAnyFlag = Boolean(
          c.hasMotion || c.hasPerson || c.hasVehicle || c.hasAnimal || c.hasFace || c.hasDoorbell || c.hasPackage || c.hasRf || c.hasOther,
        );
        return hasAnyFlag || rt.includes("md") || rt.includes("pir") || rt.includes("people") || rt.includes("person") || rt.includes("vehicle") || rt.includes("dog") || rt.includes("face");
      }).length;

      console.log("\nCHANNEL", channel);
      console.log("  clips:", clips.length, "events:", events.length);
      console.log("  detected offset bucket (ms):", offsetMs);
      console.log("  events matched/unmatched:", matchedEvents, "/", unmatchedEvents);
      console.log("  mismatches flags/recordType:", flagMismatches, "/", recordTypeMismatches);
      console.log("  clips with any event-like info:", clipsWithAnyEventLike, "/", clips.length);

      if (samples.length) {
        console.log("  sample issues:");
        console.table(samples);
      }
    }
  } finally {
    await api.close().catch(() => {});
  }
}

const channels = parseChannels(process.env.MATCH_CHANNELS);
const stream = (process.env.MATCH_STREAM ?? "main").trim().toLowerCase() === "sub" ? "sub" : "main";

const now = new Date();
const startToday = dayStartLocal(now);
const startYesterday = new Date(startToday.getTime() - 24 * 60 * 60 * 1000);
const endYesterday = startToday;

const overrideStart = process.env.MATCH_START_ISO ? new Date(process.env.MATCH_START_ISO) : null;
const overrideEnd = process.env.MATCH_END_ISO ? new Date(process.env.MATCH_END_ISO) : null;

if (overrideStart && Number.isFinite(overrideStart.getTime()) && overrideEnd && Number.isFinite(overrideEnd.getTime())) {
  await runWindow("custom", overrideStart, overrideEnd, channels, stream);
} else {
  await runWindow("today (local 00:00 -> now)", startToday, now, channels, stream);
  await runWindow("yesterday (local full day)", startYesterday, endYesterday, channels, stream);
}
