#!/usr/bin/env node
/**
 * NVR test: verify composite snapshot (PiP) for multifocal cameras behind NVR/Hub.
 *
 * What it does:
 * - fetch wide snapshot (variant=default) from NVR channel
 * - fetch tele snapshot (variant=telephoto) from the SAME NVR channel (onNvr=true)
 * - fetch composite snapshot (channel=undefined + compositeOptions)
 * - verify JPEG metadata and that tele differs from wide
 * - optionally save images to disk
 *
 * Env:
 * - NVR_HOST, NVR_USERNAME, NVR_PASSWORD (required)
 * - NVR_CHANNEL (optional, default 2)
 * - NVR_STREAM_TYPE (optional, main|sub, default main)
 * - NVR_SAVE (optional, 1 to save JPEGs under test/diagnostics/snapshots)
 */

// @ts-expect-error - resolved at runtime from dist output (ESM .js)
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";
import sharp from "sharp";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function sha1Hex(buf: Buffer): string {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

function must(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function readJpegMeta(buf: Buffer): Promise<{ width: number; height: number }> {
  const m = await sharp(buf, { failOn: "none" }).metadata();
  const width = m.width ?? 0;
  const height = m.height ?? 0;
  must(width > 0 && height > 0, `Invalid JPEG metadata: ${JSON.stringify({ width, height })}`);
  return { width, height };
}

async function main(): Promise<void> {
  const host = process.env.NVR_HOST || config.nvr.host;
  const username = process.env.NVR_USERNAME || config.nvr.username;
  const password = process.env.NVR_PASSWORD || config.nvr.password;

  must(!!host, "Missing NVR_HOST");
  must(!!username, "Missing NVR_USERNAME");
  must(!!password, "Missing NVR_PASSWORD");

  const channel = Number(process.env.NVR_CHANNEL ?? 2);
  const streamType = (process.env.NVR_STREAM_TYPE ?? "main") as "main" | "sub";
    // Default: save to disk for quick visual verification.
    // Set NVR_SAVE=0 to disable.
    const save = String(process.env.NVR_SAVE ?? "1") !== "0";

  console.log("================================================================================");
  console.log("NVR composite snapshot test");
  console.log(JSON.stringify({ host, channel, streamType, save }, null, 2));

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid: config.nvr.uid || undefined,
    logger: console,
    transport: "tcp",
    debugOptions: {
      debugRtsp: false,
      traceNativeStream: false,
      general: false,
    },
  });

  await api.login();

  // Wide + Tele snapshots (onNvr=true: tele is selected by variant on the same NVR channel).
  const wide = await api.getSnapshot(channel, { onNvr: true, variant: "default", streamType });
  const tele = await api.getSnapshot(channel, { onNvr: true, variant: "telephoto", streamType });

  const wideHash = sha1Hex(wide);
  const teleHash = sha1Hex(tele);

  const wideMeta = await readJpegMeta(wide);
  const teleMeta = await readJpegMeta(tele);

  console.log("[wide]", { bytes: wide.length, sha1: wideHash, ...wideMeta });
  console.log("[tele]", { bytes: tele.length, sha1: teleHash, ...teleMeta });

  // Basic sanity: tele should not be identical to wide.
  must(wideHash !== teleHash, "Tele snapshot hash equals wide snapshot hash (unexpected; tele lens not applied?)");

  // Composite snapshot: channel=undefined indicates composite/PiP.
  const composite = await api.getSnapshot(undefined, {
    onNvr: true,
    streamType,
    compositeOptions: {
      widerChannel: channel,
      teleChannel: channel,
      pipPosition: "bottom-right",
      pipSize: 0.25,
      pipMargin: 10,
      onNvr: true,
    },
  });

  const compHash = sha1Hex(composite);
  const compMeta = await readJpegMeta(composite);

  console.log("[composite]", { bytes: composite.length, sha1: compHash, ...compMeta });

  // Composite should keep the main (wide) dimensions.
  must(
    compMeta.width === wideMeta.width && compMeta.height === wideMeta.height,
    `Composite dimensions differ from wide: ${JSON.stringify({ wide: wideMeta, composite: compMeta })}`,
  );

  if (save) {
    const outDir = path.resolve(process.cwd(), "test/diagnostics/snapshots");
    await fs.promises.mkdir(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const widePath = path.join(outDir, `nvr_ch${channel}_wide_${ts}.jpg`);
    const telePath = path.join(outDir, `nvr_ch${channel}_tele_${ts}.jpg`);
    const compPath = path.join(outDir, `nvr_ch${channel}_composite_${ts}.jpg`);

    await fs.promises.writeFile(widePath, wide);
    await fs.promises.writeFile(telePath, tele);
    await fs.promises.writeFile(compPath, composite);

    console.log("Saved:");
    console.log("-", widePath);
    console.log("-", telePath);
    console.log("-", compPath);
  }

  await api.client.close({ reason: "composite snapshot test done" });

  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
