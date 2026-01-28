#!/usr/bin/env node
/*
Playback probe for iOS-style HTTP behavior.

This script tests multiple variants and prints:
- HTTP status
- key headers (Content-Type, Content-Length, Accept-Ranges, Content-Range)
- time-to-first-byte
- first N bytes (hex)

Usage examples:
  npm run build
  node tools/playback-probe.mjs --cgi-url "http://CAM/cgi-bin/api.cgi?..."

  # Use library login to build a VOD Playback URL and probe it
  node tools/playback-probe.mjs --host 192.168.1.161 --username admin --password "..." \
    --file "/mnt/sda/.../Rec....mp4" --channel 0

Options:
  --cgi-url <url>            Full CGI URL to probe (as-is)
  --host <ip/host>           Reolink host (used with --file)
  --username <user>
  --password <pass>
  --channel <n>              0-based channel (default: 0)
  --file <path>              Full file path (/mnt/...mp4)
  --seek <seconds>           If provided and --cgi-url has seek=, override seek for extra probes
  --bytes <n>                Bytes to read for preview (default: 2048)
  --timeout-ms <n>           Per-request timeout (default: 15000)
  --no-range                 Skip Range variants

Environment variables (alternative to flags):
  REOLINK_CGI_URL
  REOLINK_HOST, REOLINK_USERNAME, REOLINK_PASSWORD, REOLINK_CHANNEL, REOLINK_FILE
*/

import { ReolinkCgiApi, createTaggedLogger } from "../dist/index.js";
import { setTimeout as delay } from "node:timers/promises";

function getArg(name) {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return undefined;
    return process.argv[idx + 1];
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function redactUrl(url) {
    try {
        const u = new URL(url);
        // redact token/encrypt/password
        for (const key of ["token", "encrypt", "password", "user", "pwd"]) {
            if (u.searchParams.has(key)) u.searchParams.set(key, "REDACTED");
        }
        return u.toString();
    } catch {
        return url;
    }
}

async function fetchProbe(label, url, { headers, timeoutMs, previewBytes }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs).unref?.();
    const start = Date.now();

    let res;
    try {
        res = await fetch(url, {
            method: "GET",
            headers,
            redirect: "follow",
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    const tHeaders = Date.now() - start;

    const pick = (k) => res.headers.get(k) ?? res.headers.get(k.toLowerCase());
    const info = {
        status: res.status,
        statusText: res.statusText,
        contentType: pick("content-type"),
        contentLength: pick("content-length"),
        acceptRanges: pick("accept-ranges"),
        contentRange: pick("content-range"),
        cacheControl: pick("cache-control"),
        connection: pick("connection"),
        transferEncoding: pick("transfer-encoding"),
    };

    // Read first chunk(s)
    const reader = res.body?.getReader?.();
    let firstByteMs = undefined;
    let total = 0;
    const chunks = [];

    if (reader) {
        while (total < previewBytes) {
            const { value, done } = await reader.read();
            if (done) break;
            if (firstByteMs === undefined) firstByteMs = Date.now() - start;
            total += value.byteLength;
            chunks.push(Buffer.from(value));
            if (total >= previewBytes) break;
        }
        try {
            // Cancel remaining body; we only want a preview.
            await reader.cancel();
        } catch {
            // ignore
        }
    } else {
        // Fallback (older body impl)
        const buf = Buffer.from(await res.arrayBuffer());
        firstByteMs = Date.now() - start;
        chunks.push(buf.subarray(0, previewBytes));
        total = Math.min(buf.length, previewBytes);
    }

    const preview = Buffer.concat(chunks).subarray(0, previewBytes);
    const hex = preview.subarray(0, 64).toString("hex");

    let textPreview;
    const ct = (info.contentType || "").toLowerCase();
    if (ct.includes("text/") || ct.includes("json") || ct.includes("xml")) {
        // best-effort readable preview for CGI JSON errors, HTML 404 pages, etc.
        const raw = preview.toString("utf8");
        textPreview = raw.replace(/\r/g, "").trim();
        if (textPreview.length > 400) textPreview = `${textPreview.slice(0, 400)}...`;
    }

    console.log("\n===", label, "===");
    console.log("URL:", redactUrl(url));
    console.log("Request headers:", headers);
    console.log("Response:", info);
    console.log("Timing: headersMs=", tHeaders, " firstByteMs=", firstByteMs);
    console.log("Preview bytes:", total, " hex(64):", hex);
    if (textPreview) console.log("Preview text:", textPreview);
}

async function safeFetchProbe(label, url, opts) {
    try {
        await fetchProbe(label, url, opts);
    } catch (e) {
        const msg = e?.cause?.code
            ? `${e?.message || String(e)} (cause=${e.cause.code})`
            : e?.message || String(e);
        console.log("\n===", label, "===");
        console.log("URL:", redactUrl(url));
        console.log("Request headers:", opts?.headers);
        console.log("ERROR:", msg);
    }
}

function withSeek(url, seekSeconds) {
    const u = new URL(url);
    if (u.searchParams.has("seek")) {
        u.searchParams.set("seek", String(seekSeconds));
        return u.toString();
    }
    // If no seek param, add it (some firmwares accept it for Playback).
    u.searchParams.set("seek", String(seekSeconds));
    return u.toString();
}

function deriveDownloadUrlsFromCgiUrl(cgiUrl) {
    const out = [];
    let u;
    try {
        u = new URL(cgiUrl);
    } catch {
        return out;
    }

    if (!u.searchParams.has("cmd")) return out;

    // Variant A: minimal Download URL (closest to how many firmwares expect it)
    {
        const a = new URL(u);
        a.searchParams.set("cmd", "Download");
        for (const key of ["encrypt", "seek", "type", "channel", "user", "password", "pwd"]) {
            a.searchParams.delete(key);
        }
        out.push({ label: "CGI Download (derived:min)", url: a.toString() });
    }

    // Variant B: Download URL while keeping most params (except encrypt/seek)
    {
        const b = new URL(u);
        b.searchParams.set("cmd", "Download");
        for (const key of ["encrypt", "seek"]) {
            b.searchParams.delete(key);
        }
        out.push({ label: "CGI Download (derived:keep)", url: b.toString() });
    }

    // Variant C: Some firmwares use NvrDownload prepare flows; probe direct URL too.
    {
        const c = new URL(u);
        c.searchParams.set("cmd", "NvrDownload");
        for (const key of ["encrypt", "seek"]) {
            c.searchParams.delete(key);
        }
        out.push({ label: "CGI NvrDownload (derived)", url: c.toString() });
    }

    return out;
}

async function main() {
    const cgiUrl =
        getArg("--cgi-url") ||
        process.env.REOLINK_CGI_URL ||
        process.env.CGI_URL;

    const host = getArg("--host") || process.env.REOLINK_HOST;
    const username = getArg("--username") || process.env.REOLINK_USERNAME;
    const password = getArg("--password") || process.env.REOLINK_PASSWORD;
    const file = getArg("--file") || process.env.REOLINK_FILE;
    const channel = Number.parseInt(
        getArg("--channel") || process.env.REOLINK_CHANNEL || "0",
        10,
    );

    const previewBytes = Number.parseInt(getArg("--bytes") || "2048", 10);
    const timeoutMs = Number.parseInt(getArg("--timeout-ms") || "15000", 10);
    const skipRange = hasFlag("--no-range");
    const skipSeekProbes = hasFlag("--no-seek-probes");

    const probeHeadersBase = {
        // Match iOS-ish constraints
        Accept: "*/*",
        "Accept-Encoding": "identity",
        Connection: "keep-alive",
        "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/605.1.15",
    };

    const urlsToProbe = [];

    if (cgiUrl) {
        urlsToProbe.push({ label: "CGI (as-is)", url: cgiUrl });

        // Try deriving a Download URL from the provided Playback URL (many firmwares
        // use a different URL shape for Download vs Playback).
        urlsToProbe.push(...deriveDownloadUrlsFromCgiUrl(cgiUrl));

        if (!skipSeekProbes) {
            // Also probe some seek offsets to see if server returns different starting bytes.
            for (const s of [0, 1, 5, 30, 159]) {
                urlsToProbe.push({ label: `CGI seek=${s}`, url: withSeek(cgiUrl, s) });
            }
        }
    }

    if (!cgiUrl && host && username && password && file) {
        const logger = createTaggedLogger(console, "playback-probe");
        const cgi = new ReolinkCgiApi({ host, username, password, logger });

        // Try building the Playback URL from the library.
        const built = await cgi.getVodUrl(file, channel, {
            requestType: "Playback",
            // note: some firmwares ignore seek for Playback, but we can still test.
        });
        urlsToProbe.push({ label: "CGI Playback (built)", url: built });

        // Try building a Download URL from the library.
        try {
            const builtDownload = await cgi.getVodUrl(file, channel, {
                requestType: "Download",
            });
            urlsToProbe.push({ label: "CGI Download (built)", url: builtDownload });
        } catch (e) {
            console.warn(
                "Could not build CGI Download URL:",
                e?.message || String(e),
            );
        }

        // Some NVR/Hub firmwares need an NVR download flow.
        try {
            const builtNvrDownload = await cgi.getVodUrl(file, channel, {
                requestType: "NVR_DOWNLOAD",
            });
            urlsToProbe.push({
                label: "CGI NVR_DOWNLOAD (built)",
                url: builtNvrDownload,
            });
        } catch (e) {
            console.warn(
                "Could not build CGI NVR_DOWNLOAD URL:",
                e?.message || String(e),
            );
        }

        // FLV URL (seek supported) - for probing seek semantics.
        const flv = await cgi.getVodUrl(file, channel, {
            requestType: "FLV",
            seek: 159,
        });
        urlsToProbe.push({ label: "FLV (seek=159)", url: flv });
    }

    if (urlsToProbe.length === 0) {
        console.error(
            "Provide either --cgi-url or (--host --username --password --file).",
        );
        process.exit(2);
    }

    for (const { label, url } of urlsToProbe) {
        // No-range baseline
        await safeFetchProbe(`${label} (no Range)`, url, {
            headers: { ...probeHeadersBase },
            timeoutMs,
            previewBytes,
        });

        if (!skipRange) {
            for (const range of [
                "bytes=0-1",
                "bytes=0-1023",
                "bytes=1024-2047",
                "bytes=0-65535",
            ]) {
                await safeFetchProbe(`${label} (Range ${range})`, url, {
                    headers: { ...probeHeadersBase, Range: range },
                    timeoutMs,
                    previewBytes,
                });
                // small pause to avoid hammering the camera
                await delay(150);
            }
        }

        await delay(250);
    }
}

await main();
