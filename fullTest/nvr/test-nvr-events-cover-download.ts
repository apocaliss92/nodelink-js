#!/usr/bin/env npx ts-node
/**
 * Replica del flusso catturato in "pcap/192.168.1.161 events+cover+download.pcapng"
 *
 * Per ogni channel (0, 1, 2) dell'NVR:
 * - Lista eventi di oggi e ieri
 * - Download clip MP4 primo evento di ieri e oggi
 * - Download cover (snapshot) primo evento di ieri e oggi
 *
 * Utilizzo:
 *   npx ts-node fullTest/nvr/test-nvr-events-cover-download.ts
 *
 * Oppure con variabili d'ambiente:
 *   CHANNELS=0,1 npx ts-node fullTest/nvr/test-nvr-events-cover-download.ts
 *   DEBUG=1 npx ts-node fullTest/nvr/test-nvr-events-cover-download.ts
 */

import "../env.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "../env.js";

// @ts-expect-error - Path resolution at runtime
import {
  ReolinkBaichuanApi,
  createLogger,
  type RecordingFile,
} from "../../index.js";

// ============================================================================
// Configurazione
// ============================================================================

const NVR_HOST = process.env.NVR_HOST || config.nvr.host;
const NVR_USERNAME = process.env.NVR_USERNAME || config.nvr.username;
const NVR_PASSWORD = process.env.NVR_PASSWORD || config.nvr.password;
const NVR_UID = process.env.NVR_UID || config.nvr.uid;

const CHANNELS = process.env.CHANNELS
  ? process.env.CHANNELS.split(",").map((s) => parseInt(s.trim(), 10))
  : [0, 1, 2];

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const OUT_DIR = process.env.OUT_DIR || "./downloads/nvr-events-cover-download";

// ============================================================================
// Tipi
// ============================================================================

interface EventInfo {
  fileName: string;
  startTime: Date | null;
  endTime: Date | null;
  recordType?: string;
  alarmType?: string;
}

interface ChannelResult {
  channel: number;
  todayEvents: EventInfo[];
  yesterdayEvents: EventInfo[];
  downloads: {
    type: "clip" | "cover";
    day: "today" | "yesterday";
    fileName: string;
    outputPath: string;
    success: boolean;
    error?: string;
    sizeBytes?: number;
  }[];
}

// ============================================================================
// Utilità
// ============================================================================

function getStartOfDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0,
  );
}

function getEndOfDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999,
  );
}

function formatDateForFile(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║  NVR Events + Cover + Download Test                          ║",
  );
  console.log(
    "║  (Replica del flusso pcap/192.168.1.161 events+cover+download)║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );
  console.log();

  if (!NVR_HOST || !NVR_USERNAME || !NVR_PASSWORD) {
    console.error(
      "❌ Mancano le credenziali NVR! Configura NVR_HOST, NVR_USERNAME, NVR_PASSWORD in .env",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`📡 Host: ${NVR_HOST}`);
  console.log(`👤 Username: ${NVR_USERNAME}`);
  console.log(`🔑 Password: ${"*".repeat(NVR_PASSWORD.length)}`);
  console.log(`📺 Channels: ${CHANNELS.join(", ")}`);
  console.log(`📁 Output dir: ${OUT_DIR}`);
  console.log();

  // Crea la directory di output
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Date di riferimento
  const now = new Date();
  const today = {
    start: getStartOfDay(now),
    end: now,
    label: "today",
    dateStr: formatDateForFile(now),
  };
  const yesterday = {
    start: getStartOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    end: getEndOfDay(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    label: "yesterday",
    dateStr: formatDateForFile(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
  };

  console.log(
    `📅 Oggi: ${today.start.toISOString()} - ${today.end.toISOString()}`,
  );
  console.log(
    `📅 Ieri: ${yesterday.start.toISOString()} - ${yesterday.end.toISOString()}`,
  );
  console.log();

  const logger = createLogger({
    name: "nvr-events-cover-download",
    level: DEBUG ? "debug" : "info",
  });

  const results: ChannelResult[] = [];

  for (const channel of CHANNELS) {
    console.log("━".repeat(70));
    console.log(`📺 CHANNEL ${channel}`);
    console.log("━".repeat(70));

    const result: ChannelResult = {
      channel,
      todayEvents: [],
      yesterdayEvents: [],
      downloads: [],
    };

    // Crea un'istanza API per questo canale
    const api = new ReolinkBaichuanApi({
      host: NVR_HOST,
      username: NVR_USERNAME,
      password: NVR_PASSWORD,
      uid: NVR_UID,
      channel,
      logger,
      debugOptions: DEBUG ? { traceRecordings: true } : undefined,
    });

    try {
      // ========================================================================
      // 1. Lista eventi di OGGI (prova entrambi i metodi)
      // ========================================================================
      console.log(`\n  🔍 Recupero eventi di OGGI (channel ${channel})...`);
      try {
        // Prima proviamo con listRecordings (FileInfoList)
        let todayEventsRaw = await api.listRecordings({
          channel,
          start: today.start,
          end: today.end,
          streamType: "mainStream",
          recordType:
            "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
          timeoutMs: 30_000,
        });

        // Se non troviamo nulla, proviamo con findAlarmVideo
        if (todayEventsRaw.length === 0) {
          console.log(`     📋 FileInfoList vuoto, provo findAlarmVideo...`);
          try {
            todayEventsRaw = await api.listAlarmVideosViaBaichuan({
              channel,
              start: today.start,
              end: today.end,
              streamType: "mainStream",
              timeoutMs: 30_000,
            });
          } catch {
            // findAlarmVideo può non essere supportato
            console.log(`     📋 findAlarmVideo non disponibile`);
          }
        }

        result.todayEvents = todayEventsRaw.map((e: RecordingFile) => ({
          fileName: e.fileName,
          startTime: e.startTime ?? null,
          endTime: e.endTime ?? null,
          recordType: e.recordType,
        }));

        console.log(`     ✅ Trovati ${result.todayEvents.length} eventi oggi`);
        if (result.todayEvents.length > 0) {
          const first = result.todayEvents[0];
          console.log(`        Primo evento: ${first.fileName}`);
          if (first.startTime) {
            console.log(`        Start: ${first.startTime.toISOString()}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`     ⚠️  Errore lista eventi oggi: ${msg}`);
      }

      // ========================================================================
      // 2. Lista eventi di IERI (prova entrambi i metodi)
      // ========================================================================
      console.log(`\n  🔍 Recupero eventi di IERI (channel ${channel})...`);
      try {
        // Prima proviamo con listRecordings (FileInfoList)
        let yesterdayEventsRaw = await api.listRecordings({
          channel,
          start: yesterday.start,
          end: yesterday.end,
          streamType: "mainStream",
          recordType:
            "manual, sched, io, md, people, face, vehicle, dog_cat, visitor, other, package",
          timeoutMs: 30_000,
        });

        // Se non troviamo nulla, proviamo con findAlarmVideo
        if (yesterdayEventsRaw.length === 0) {
          console.log(`     📋 FileInfoList vuoto, provo findAlarmVideo...`);
          try {
            yesterdayEventsRaw = await api.listAlarmVideosViaBaichuan({
              channel,
              start: yesterday.start,
              end: yesterday.end,
              streamType: "mainStream",
              timeoutMs: 30_000,
            });
          } catch {
            // findAlarmVideo può non essere supportato
            console.log(`     📋 findAlarmVideo non disponibile`);
          }
        }

        result.yesterdayEvents = yesterdayEventsRaw.map((e: RecordingFile) => ({
          fileName: e.fileName,
          startTime: e.startTime ?? null,
          endTime: e.endTime ?? null,
          recordType: e.recordType,
        }));

        console.log(
          `     ✅ Trovati ${result.yesterdayEvents.length} eventi ieri`,
        );
        if (result.yesterdayEvents.length > 0) {
          const first = result.yesterdayEvents[0];
          console.log(`        Primo evento: ${first.fileName}`);
          if (first.startTime) {
            console.log(`        Start: ${first.startTime.toISOString()}`);
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.log(`     ⚠️  Errore lista eventi ieri: ${msg}`);
      }

      // ========================================================================
      // 3. Download clip MP4 - primo evento di OGGI
      // ========================================================================
      if (result.todayEvents.length > 0) {
        const event = result.todayEvents[0];
        const outFileName = `ch${channel}_${today.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}`;
        const outPath = path.join(OUT_DIR, outFileName);

        console.log(`\n  📥 Download clip OGGI (channel ${channel})...`);
        console.log(`     File: ${event.fileName}`);
        console.log(`     Output: ${outPath}`);

        try {
          const clipBuffer = await api.downloadRecording({
            channel,
            fileName: event.fileName,
            timeoutMs: 120_000,
          });

          await fs.writeFile(outPath, clipBuffer);
          const stats = await fs.stat(outPath);

          result.downloads.push({
            type: "clip",
            day: "today",
            fileName: event.fileName,
            outputPath: outPath,
            success: true,
            sizeBytes: stats.size,
          });

          console.log(`     ✅ Salvato: ${stats.size} bytes`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.downloads.push({
            type: "clip",
            day: "today",
            fileName: event.fileName,
            outputPath: outPath,
            success: false,
            error: msg,
          });
          console.log(`     ⚠️  Errore download clip: ${msg}`);
        }
      }

      // ========================================================================
      // 4. Download clip MP4 - primo evento di IERI
      // ========================================================================
      if (result.yesterdayEvents.length > 0) {
        const event = result.yesterdayEvents[0];
        const outFileName = `ch${channel}_${yesterday.dateStr}_clip_${sanitizeFileName(path.basename(event.fileName))}`;
        const outPath = path.join(OUT_DIR, outFileName);

        console.log(`\n  📥 Download clip IERI (channel ${channel})...`);
        console.log(`     File: ${event.fileName}`);
        console.log(`     Output: ${outPath}`);

        try {
          const clipBuffer = await api.downloadRecording({
            channel,
            fileName: event.fileName,
            timeoutMs: 120_000,
          });

          await fs.writeFile(outPath, clipBuffer);
          const stats = await fs.stat(outPath);

          result.downloads.push({
            type: "clip",
            day: "yesterday",
            fileName: event.fileName,
            outputPath: outPath,
            success: true,
            sizeBytes: stats.size,
          });

          console.log(`     ✅ Salvato: ${stats.size} bytes`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.downloads.push({
            type: "clip",
            day: "yesterday",
            fileName: event.fileName,
            outputPath: outPath,
            success: false,
            error: msg,
          });
          console.log(`     ⚠️  Errore download clip: ${msg}`);
        }
      }

      // ========================================================================
      // 5. Download cover (snapshot) - primo evento di OGGI
      // ========================================================================
      if (result.todayEvents.length > 0 && result.todayEvents[0].startTime) {
        const event = result.todayEvents[0];
        const outFileName = `ch${channel}_${today.dateStr}_cover_${sanitizeFileName(path.basename(event.fileName))}.h264`;
        const outPath = path.join(OUT_DIR, outFileName);

        console.log(`\n  🖼️  Download cover OGGI (channel ${channel})...`);
        console.log(`     Time: ${event.startTime!.toISOString()}`);
        console.log(`     Output: ${outPath}`);

        try {
          const snapshot = await api.snapshotFromPlayback({
            channel,
            time: event.startTime!,
            snapType: "sub",
            timeoutMs: 30_000,
          });

          await fs.writeFile(outPath, snapshot.frameData);
          const stats = await fs.stat(outPath);

          result.downloads.push({
            type: "cover",
            day: "today",
            fileName: event.fileName,
            outputPath: outPath,
            success: true,
            sizeBytes: stats.size,
          });

          console.log(
            `     ✅ Salvato: ${stats.size} bytes (codec: ${snapshot.codec})`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.downloads.push({
            type: "cover",
            day: "today",
            fileName: event.fileName,
            outputPath: outPath,
            success: false,
            error: msg,
          });
          console.log(`     ⚠️  Errore download cover: ${msg}`);
        }
      }

      // ========================================================================
      // 6. Download cover (snapshot) - primo evento di IERI
      // ========================================================================
      if (
        result.yesterdayEvents.length > 0 &&
        result.yesterdayEvents[0].startTime
      ) {
        const event = result.yesterdayEvents[0];
        const outFileName = `ch${channel}_${yesterday.dateStr}_cover_${sanitizeFileName(path.basename(event.fileName))}.h264`;
        const outPath = path.join(OUT_DIR, outFileName);

        console.log(`\n  🖼️  Download cover IERI (channel ${channel})...`);
        console.log(`     Time: ${event.startTime!.toISOString()}`);
        console.log(`     Output: ${outPath}`);

        try {
          const snapshot = await api.snapshotFromPlayback({
            channel,
            time: event.startTime!,
            snapType: "sub",
            timeoutMs: 30_000,
          });

          await fs.writeFile(outPath, snapshot.frameData);
          const stats = await fs.stat(outPath);

          result.downloads.push({
            type: "cover",
            day: "yesterday",
            fileName: event.fileName,
            outputPath: outPath,
            success: true,
            sizeBytes: stats.size,
          });

          console.log(
            `     ✅ Salvato: ${stats.size} bytes (codec: ${snapshot.codec})`,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.downloads.push({
            type: "cover",
            day: "yesterday",
            fileName: event.fileName,
            outputPath: outPath,
            success: false,
            error: msg,
          });
          console.log(`     ⚠️  Errore download cover: ${msg}`);
        }
      }
    } finally {
      // Chiudi la connessione
      try {
        await api.client.close();
      } catch {
        // ignore
      }
    }

    results.push(result);
  }

  // ============================================================================
  // Riepilogo finale
  // ============================================================================
  console.log("\n");
  console.log(
    "╔══════════════════════════════════════════════════════════════╗",
  );
  console.log(
    "║  RIEPILOGO                                                   ║",
  );
  console.log(
    "╚══════════════════════════════════════════════════════════════╝",
  );

  for (const r of results) {
    console.log(`\n📺 Channel ${r.channel}:`);
    console.log(`   Eventi oggi:     ${r.todayEvents.length}`);
    console.log(`   Eventi ieri:     ${r.yesterdayEvents.length}`);

    const successClips = r.downloads.filter(
      (d) => d.type === "clip" && d.success,
    );
    const failedClips = r.downloads.filter(
      (d) => d.type === "clip" && !d.success,
    );
    const successCovers = r.downloads.filter(
      (d) => d.type === "cover" && d.success,
    );
    const failedCovers = r.downloads.filter(
      (d) => d.type === "cover" && !d.success,
    );

    console.log(
      `   Clip scaricate:  ${successClips.length} ✅ / ${failedClips.length} ❌`,
    );
    console.log(
      `   Cover scaricate: ${successCovers.length} ✅ / ${failedCovers.length} ❌`,
    );

    if (successClips.length > 0 || successCovers.length > 0) {
      console.log(`   File salvati:`);
      for (const d of r.downloads.filter((d) => d.success)) {
        const sizeKb = d.sizeBytes
          ? `${(d.sizeBytes / 1024).toFixed(1)} KB`
          : "?";
        console.log(`     - ${path.basename(d.outputPath)} (${sizeKb})`);
      }
    }
  }

  // Salva il report JSON
  const reportPath = path.join(OUT_DIR, "report.json");
  await fs.writeFile(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n📝 Report salvato: ${reportPath}`);

  // Exit code
  const totalSuccess = results
    .flatMap((r) => r.downloads)
    .filter((d) => d.success).length;
  const totalFailed = results
    .flatMap((r) => r.downloads)
    .filter((d) => !d.success).length;

  if (totalFailed > 0 && totalSuccess === 0) {
    process.exitCode = 1;
  }

  console.log("\n✨ Completato!");
}

main().catch((e) => {
  console.error("💥 Errore fatale:", e);
  process.exitCode = 1;
});
