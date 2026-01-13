#!/usr/bin/env node
/**
 * NVR CoverPreview snapshot test from eventId.
 *
 * This script is meant to reproduce thumbnail failures locally and show whether
 * CoverPreview (cmdId=298) is accepted by the NVR.
 *
 * Env (in addition to NVR_HOST/NVR_USERNAME/NVR_PASSWORD):
 * - NVR_EVENT_ID / EVENT_ID: rbj:event:v1:... to snapshot
 * - COVERPREVIEW_CHANNEL: override channel (0-based) when eventId does not contain it
 * - COVERPREVIEW_SNAPTYPE: "sub" | "main" (default: sub)
 * - COVERPREVIEW_TIMEOUT_MS: CoverPreview timeout (default: 30000)
 * - COVERPREVIEW_OUT: output file path (default: test/diagnostics/coverpreview-frame.bin)
 * - COVERPREVIEW_JPEG=1: also convert to JPEG (requires ffmpeg in PATH)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// @ts-expect-error - Path resolution at runtime
import { encodeReolinkEventIdV1, ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function envBool(v: string | undefined): boolean {
    return /^(1|true|yes)$/i.test((v ?? "").trim());
}

function envNum(v: string | undefined): number | undefined {
    if (!v) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    return n;
}

async function sleepMs(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

async function waitForPushCache(api: ReolinkBaichuanApi, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + Math.max(0, Math.trunc(timeoutMs));
    while (Date.now() < deadline) {
        try {
            if (api.getChannelInfoFromPushCache().size > 0) return;
        } catch {
            // ignore
        }
        await sleepMs(100);
    }
}

async function main(): Promise<void> {
    const { host, username, password, uid } = config.nvr;
    if (!host) throw new Error("Missing NVR_HOST in .env");
    if (!username) throw new Error("Missing NVR_USERNAME in .env");
    if (!password) throw new Error("Missing NVR_PASSWORD in .env");

    const eventId = (process.env.NVR_EVENT_ID ?? process.env.EVENT_ID ?? "").trim();
    const snapType = ((process.env.COVERPREVIEW_SNAPTYPE ?? "sub").trim() as "sub" | "main");
    const timeoutMs = envNum(process.env.COVERPREVIEW_TIMEOUT_MS) ?? 30_000;
    const jpeg = envBool(process.env.COVERPREVIEW_JPEG);
    const headerChannelIdOverride =
        envNum(process.env.COVERPREVIEW_HEADER_CHANNEL_ID) ?? envNum(process.env.COVERPREVIEW_CHANNEL_ID);

    const outDefault = path.join("test", "diagnostics", "coverpreview-frame.bin");
    const outPath = (process.env.COVERPREVIEW_OUT ?? outDefault).trim();
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const api = new ReolinkBaichuanApi({
        host,
        username,
        password,
        uid,
        timeoutMs: 30_000,
        debugOptions: {
            general: envBool(process.env.DEBUG_GENERAL),
            traceRecordings: envBool(process.env.DEBUG_RECORDINGS),
        },
    });

    console.log(`NVR: ${host}`);
    console.log(`snapType=${snapType} timeoutMs=${timeoutMs}`);

    await api.login();

    let idToUse = eventId;
    if (!idToUse) {
        console.log("EVENT_ID not provided; fetching a recent eventId via Baichuan...");
        const end = new Date();
        const lookbackHours = envNum(process.env.EVENTS_LOOKBACK_HOURS) ?? 6;
        const start = new Date(end.getTime() - Math.max(1, lookbackHours) * 60 * 60 * 1000);

        const events = await api.listNvrAlarmEventsEnrichedViaBaichuan({
            start,
            end,
            channels: envNum(process.env.COVERPREVIEW_CHANNEL) != null ? [Math.floor(envNum(process.env.COVERPREVIEW_CHANNEL)!)] : undefined,
            maxIterations: 20,
        });

        if (events.length) {
            idToUse = events[0]!.eventId;
            console.log(`Using first eventId: ${idToUse}`);
        } else {
            console.log("No alarm events found; trying listEventLogs()...");

            // listEventLogs relies on cmd_id 145 push cache for UID mapping.
            // Give the device a moment after login to send it.
            await waitForPushCache(api, envNum(process.env.EVENTS_PUSH_WAIT_MS) ?? 2000);

            const eventLogChannelId = envNum(process.env.EVENTLOG_CHANNEL_ID);
            const logs = await api.listEventLogs({
                start,
                end,
                count: 50,
                requireHasRecFile: true,
                ...(eventLogChannelId != null
                    ? { channelId: Math.floor(eventLogChannelId) }
                    : {}),
            });

            if (!logs.length) {
                throw new Error(
                    `No events found via listNvrAlarmEventsEnrichedViaBaichuan nor listEventLogs in the last ${lookbackHours}h. Provide NVR_EVENT_ID/EVENT_ID explicitly.`,
                );
            }

            const ev = logs[0]!;
            const chOverride = envNum(process.env.COVERPREVIEW_CHANNEL);
            const channel = chOverride != null ? Math.floor(chOverride) : ev.logicChn ?? 0;
            idToUse = encodeReolinkEventIdV1({
                kind: "nvrAlarm",
                channel,
                // File name isn't available from EventLog; we only need a stable non-empty id.
                fileName: `eventlog:${ev.uid}:${ev.startTime.getTime()}`,
                startTimeMs: ev.startTime.getTime(),
                endTimeMs: ev.endTime.getTime(),
                uid: ev.uid,
            });
            console.log(`Using eventId synthesized from EventLog: ${idToUse}`);
        }
    }

    const chOverride = envNum(process.env.COVERPREVIEW_CHANNEL);

    try {
        console.log("Requesting CoverPreview snapshot...");
        const snap = await api.snapshotFromNvrEventId({
            idOrFileName: idToUse,
            ...(chOverride != null ? { channel: Math.floor(chOverride) } : {}),
            ...(headerChannelIdOverride != null ? { headerChannelId: Math.floor(headerChannelIdOverride) } : {}),
            snapType,
            timeoutMs,
        });

        fs.writeFileSync(outPath, snap.frame);
        console.log(`OK: wrote raw I-frame (${snap.encoding}, ${snap.frameLength} bytes) to ${outPath}`);

        if (jpeg) {
            const jpgPath = outPath.replace(/\.bin$/i, "") + ".jpg";
            const jpg = await api.snapshotJpegFromNvrEventId({
                idOrFileName: idToUse,
                ...(chOverride != null ? { channel: Math.floor(chOverride) } : {}),
                ...(headerChannelIdOverride != null ? { headerChannelId: Math.floor(headerChannelIdOverride) } : {}),
                snapType,
                timeoutMs,
            });
            fs.writeFileSync(jpgPath, jpg);
            console.log(`OK: wrote JPEG to ${jpgPath}`);
        }
    } finally {
        await api.close().catch(() => undefined);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
