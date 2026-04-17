/* eslint-disable no-console */
/**
 * Smoke test for issue #8 point 3:
 *   Wired cams snapshot path shouldn't error.
 *
 * The user sees a repeated go2rtc log:
 *   [go2rtc] ... mjpeg.go:82 > error="streams: EOF"
 * That is go2rtc's MJPEG (ffmpeg-based) snapshot chain closing the source
 * after grabbing a single frame — a cosmetic warning from go2rtc itself, not
 * from this library. Confirmed by reading the server path: our snapshot
 * procedure uses api.getSnapshot (CGI), which does NOT go through go2rtc.
 *
 * This script just checks that api.getSnapshot works end-to-end on the two
 * wired cameras configured in .env (H.264 + H.265), so we can point the user
 * at the fact that the warning is benign.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

async function grab(name: string, host?: string, user?: string, pass?: string) {
  if (!host) return;
  console.log(`\n── ${name} @ ${host} ──`);
  const api = new ReolinkBaichuanApi({
    host,
    username: user ?? "admin",
    password: pass ?? "",
  });
  try {
    await api.login();
    const t = Date.now();
    const buf = await api.getSnapshot(0);
    console.log(
      `  ✓ getSnapshot ok — ${buf.length} bytes in ${Date.now() - t}ms (JPEG magic=${buf
        .subarray(0, 3)
        .toString("hex")})`,
    );
  } catch (e) {
    console.log(`  ✗ getSnapshot FAILED: ${e}`);
  } finally {
    await api.close().catch(() => {});
  }
}

async function main() {
  await grab("TCP (H.264)", process.env.TCP_HOST, process.env.TCP_USERNAME, process.env.TCP_PASSWORD);
  await grab(
    "TCP265 (H.265)",
    process.env.TCP265_HOST,
    process.env.TCP265_USERNAME,
    process.env.TCP265_PASSWORD,
  );
  process.exit(0);
}

void main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(2);
});
