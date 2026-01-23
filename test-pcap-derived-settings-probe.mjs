#!/usr/bin/env node
/*
 * Probe script for PCAP-derived Baichuan settings cmdIds.
 *
 * Runs against:
 * - TCP_HOST (standalone camera)
 * - NVR_HOST (Home Hub / NVR)
 *
 * Prereq:
 *   npm run build
 *   cp env.template .env && edit
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "./dist/index.js";

const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? "10000");
const PROBE_HARD_TIMEOUT_MS = Number(
    process.env.PROBE_HARD_TIMEOUT_MS ?? String(PROBE_TIMEOUT_MS + 2000),
);
const PROBE_MAX_CHANNELS =
    process.env.PROBE_MAX_CHANNELS != null
        ? Number(process.env.PROBE_MAX_CHANNELS)
        : undefined;

function envBool(name, defaultValue = false) {
    const v = process.env[name];
    if (v == null) return defaultValue;
    const s = String(v).trim().toLowerCase();
    return s === "1" || s === "true" || s === "yes" || s === "y";
}

function parseCsvNumbers(v) {
    if (!v) return undefined;
    const out = String(v)
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0);
    return out.length ? out : undefined;
}

function redactXml(xml) {
    let s = String(xml ?? "");
    // Redact common credential-like fields.
    const tags = [
        "password",
        "passwd",
        "pwd",
        "key",
        "psk",
        "secret",
        "token",
        "apikey",
        "apiKey",
        "userPwd",
        "wifiKey",
        "rtspPassword",
        "encPwd",
    ];

    for (const t of tags) {
        const re = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`, "gi");
        s = s.replace(re, `<${t}>********</${t}>`);
    }
    // Also redact obvious attributes.
    s = s.replace(/(password|passwd|pwd|key)\s*=\s*"[^"]*"/gi, `$1="********"`);
    return s;
}

function compactXmlSnippet(xml, maxLen = 240) {
    const s = redactXml(xml).replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length <= maxLen ? s : s.slice(0, maxLen) + " …";
}

function safeJsonStringifyRedacted(value) {
    const redact = new Set([
        "password",
        "passwd",
        "pwd",
        "key",
        "psk",
        "secret",
        "token",
        "apikey",
        "apiKey",
        "userPwd",
        "wifiKey",
        "rtspPassword",
        "encPwd",
    ]);
    return JSON.stringify(value, (k, v) => (redact.has(k) ? "********" : v));
}

function compactJsonSnippet(value, maxLen = 240) {
    let s = "";
    try {
        s = safeJsonStringifyRedacted(value);
    } catch {
        s = String(value ?? "");
    }
    s = String(s ?? "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    return s.length <= maxLen ? s : s.slice(0, maxLen) + " …";
}

function extractTopKeys(value, max = 12) {
    if (!value || typeof value !== "object") return [];
    return Object.keys(value).slice(0, max);
}

function extractTags(xml, max = 12) {
    const s = String(xml ?? "");
    const re = /<([A-Za-z0-9_:-]+)(\s|>)/g;
    const tags = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(s))) {
        const t = m[1];
        if (!t || t === "?xml" || t.startsWith("/")) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        tags.push(t);
        if (tags.length >= max) break;
    }
    return tags;
}

async function safeCall(label, fn) {
    const t0 = Date.now();
    try {
        const res = await Promise.race([
            fn(),
            new Promise((_, reject) =>
                setTimeout(
                    () => reject(new Error(`probe hard-timeout after ${PROBE_HARD_TIMEOUT_MS}ms`)),
                    PROBE_HARD_TIMEOUT_MS,
                ),
            ),
        ]);
        const dt = Date.now() - t0;
        return { ok: true, label, dtMs: dt, res };
    } catch (e) {
        const dt = Date.now() - t0;
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, label, dtMs: dt, error: msg };
    }
}

function printResult(r) {
    const prefix = r.ok ? "OK " : "ERR";
    if (!r.ok) {
        console.log(`${prefix} (${r.dtMs}ms) ${r.label}: ${r.error}`);
        return;
    }

    const keys = extractTopKeys(r.res);
    const snippet = compactJsonSnippet(r.res);
    const len = (() => {
        try {
            return safeJsonStringifyRedacted(r.res).length;
        } catch {
            return typeof r.res === "string" ? r.res.length : 0;
        }
    })();

    console.log(`${prefix} (${r.dtMs}ms) ${r.label}: jsonLen=${len} keys=${keys.join(",")}`);
    if (snippet) console.log(`     ${snippet}`);
}

async function runTarget(targetLabel, cfg) {
    if (!cfg.host || !cfg.password) {
        console.log(`\n=== Skip ${targetLabel}: missing host/password in env ===`);
        return;
    }

    console.log(`\n=== Target: ${targetLabel} ===`);
    console.log(`host=${cfg.host} transport=tcp username=${cfg.username ?? ""}`);

    const silentLogger = {
        debug() { },
        info() { },
        log() { },
        warn() { },
        error() { },
    };

    const verbose = envBool("PROBE_VERBOSE");
    const abortOnHardTimeout = envBool("PROBE_ABORT_ON_HARD_TIMEOUT", false);

    const api = new ReolinkBaichuanApi({
        host: cfg.host,
        username: cfg.username ?? "admin",
        password: cfg.password,
        transport: "tcp",
        ...(cfg.uid ? { uid: cfg.uid } : {}),
        logger: verbose ? console : silentLogger,
        debugOptions: {
            general: envBool("BAICHUAN_DEBUG"),
            traceEvents: envBool("BAICHUAN_TRACE_EVENTS"),
            traceNativeStream: envBool("BAICHUAN_TRACE_STREAM"),
            traceTalk: envBool("BAICHUAN_TRACE_TALK"),
            traceRecordings: envBool("BAICHUAN_TRACE_RECORDINGS"),
            dump: envBool("BAICHUAN_DUMP"),
            dumpDir: process.env.BAICHUAN_DUMP_DIR,
            dumpBcmedia: envBool("BAICHUAN_DUMP_BCMEDIA"),
            dumpNals: envBool("BAICHUAN_DUMP_NALS"),
        },
    });

    try {
        await api.login();

        // For NVR: try to discover channels if not provided.
        let channels = cfg.channels;
        if (channels == null) {
            const sum = await safeCall("getNvrChannelsSummary", async () => {
                return await api.getNvrChannelsSummary({ timeoutMs: 10_000 });
            });
            if (sum.ok) {
                const arr = sum.res?.channels;
                if (Array.isArray(arr) && arr.length) {
                    const extracted = arr
                        .map((x) => {
                            if (typeof x === "number") return x;
                            if (x && typeof x === "object") {
                                if (typeof x.channel === "number") return x.channel;
                                if (typeof x.chnID === "number") return x.chnID;
                                if (typeof x.id === "number") return x.id;
                            }
                            return undefined;
                        })
                        .filter((n) => Number.isFinite(n));
                    if (extracted.length) channels = extracted;
                }
            }
        }

        if (!channels || !channels.length) channels = [0];
        channels = [...new Set(channels)].sort((a, b) => a - b);

        if (PROBE_MAX_CHANNELS != null && Number.isFinite(PROBE_MAX_CHANNELS)) {
            channels = channels.slice(0, Math.max(0, PROBE_MAX_CHANNELS));
            if (channels.length === 0) channels = [0];
        }

        console.log(`channels=${channels.join(",")}`);

        const timeoutMs = Number.isFinite(PROBE_TIMEOUT_MS) ? PROBE_TIMEOUT_MS : 10_000;

        const globalCalls = [
            ["getHddInfoList", () => api.getHddInfoList({ timeoutMs })],
            ["getKitApCfg", () => api.getKitApCfg({ timeoutMs })],
            ["getAccessUserList", () => api.getAccessUserList({ timeoutMs })],
        ];

        for (const [label, fn] of globalCalls) {
            printResult(await safeCall(label, fn));
        }

        // Channel-scoped calls.
        for (const ch of channels) {
            console.log(`\n--- Channel ${ch} ---`);

            const calls = [
                ["getOsdDatetime", () => api.getOsdDatetime(ch, { timeoutMs })],
                ["getRecordCfg", () => api.getRecordCfg(ch, { timeoutMs })],
                ["getRecordSchedule", () => api.getRecordSchedule(ch, { timeoutMs })],
                ["getWifiSignal", () => api.getWifiSignal(ch, { timeoutMs })],
                ["getWifi", () => api.getWifi(ch, { timeoutMs })],
                ["getStreamInfoList", () => api.getStreamInfoList(ch, { timeoutMs })],
                ["getLedState", () => api.getLedState(ch, { timeoutMs })],
                ["getSleepState", () => api.getSleepState(ch, { timeoutMs })],

                ["getAbilitySupport", () => api.getAbilitySupport(ch, { timeoutMs })],
                ["getFtpTask", () => api.getFtpTask(ch, { timeoutMs })],
                ["getDayRecords", () => api.getDayRecords(ch, { timeoutMs })],
                ["getEmailTask", () => api.getEmailTask(ch, { timeoutMs })],
                ["getAudioTask", () => api.getAudioTask(ch, { timeoutMs })],
                ["getAudioCfg", () => api.getAudioCfg(ch, { timeoutMs })],
                ["getDayNightThreshold", () => api.getDayNightThreshold(ch, { timeoutMs })],
                ["getTimelapseCfg", () => api.getTimelapseCfg(ch, { timeoutMs })],
                ["getAiDenoise", () => api.getAiDenoise(ch, { timeoutMs })],
                ["getRecEncCfg", () => api.getRecEncCfg(ch, { timeoutMs })],

                ["getCmd123", () => api.getCmd123(ch, { timeoutMs })],
                ["getCmd209", () => api.getCmd209(ch, { timeoutMs })],
                ["getCmd231", () => api.getCmd231(ch, { timeoutMs })],
                ["getCmd265", () => api.getCmd265(ch, { timeoutMs })],
                ["getCmd440", () => api.getCmd440(ch, { timeoutMs })],
            ];

            for (const [label, fn] of calls) {
                const r = await safeCall(label, fn);
                printResult(r);
                if (!r.ok && r.error.includes("probe hard-timeout")) {
                    if (abortOnHardTimeout) {
                        // Avoid getting stuck in reconnect loops. Close and abort this target.
                        console.log(
                            `ERR aborting ${targetLabel}: ${label} exceeded hard-timeout (set PROBE_ABORT_ON_HARD_TIMEOUT=0 to continue)`,
                        );
                        return;
                    }
                    console.log(
                        `ERR continuing ${targetLabel}: ${label} exceeded hard-timeout (set PROBE_ABORT_ON_HARD_TIMEOUT=1 to abort)`,
                    );
                }
            }
        }

        const dumpPushCache = envBool("PROBE_DUMP_PUSH_CACHE");
        if (dumpPushCache) {
            console.log("\n--- Settings push cache snapshot ---");
            console.log(
                JSON.stringify(
                    Array.from(api.getSettingsPushCacheSnapshot().entries()),
                    null,
                    2,
                ),
            );
        }
    } finally {
        await api.close({ reason: "probe done" });
    }
}

async function main() {
    const tcp = {
        host: process.env.TCP_HOST,
        username: process.env.TCP_USERNAME,
        password: process.env.TCP_PASSWORD,
        uid: process.env.TCP_UID,
        channels: parseCsvNumbers(process.env.TCP_CHANNELS) ?? [0],
    };

    const nvr = {
        host: process.env.NVR_HOST,
        username: process.env.NVR_USERNAME,
        password: process.env.NVR_PASSWORD,
        uid: process.env.NVR_UID,
        channels: parseCsvNumbers(process.env.NVR_CHANNELS),
    };

    await runTarget("TCP_HOST", tcp);
    await runTarget("NVR_HOST", nvr);

    console.log("\n=== Done ===");
}

main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
});
