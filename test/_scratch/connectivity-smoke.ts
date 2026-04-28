/* eslint-disable no-console */
/**
 * Connectivity smoke test for every camera in .env.
 *
 * Goal: prove that every cable AND battery camera can:
 *   1. login()
 *   2. ping()
 *   3. getInfo() / getChannelCount()
 *   4. for battery cams: survive a forced close + ensureConnected() (mimics
 *      the watchdog reconnect path and the battery idle-disconnect cycle).
 *
 * Usage: npx tsx test/_scratch/connectivity-smoke.ts
 *
 * Reads from .env (see env.template):
 *   TCP_HOST, TCP265_HOST, UDP_HOST + UDP_UID, UDP_STANDALONE_HOST + UDP_STANDALONE_UID,
 *   UDP_SLEEP_HOST + UDP_SLEEP_UID, NVR_HOST + NVR_UID, HUB_HOST.
 */

import "dotenv/config";
import { ReolinkBaichuanApi } from "../../src/reolink/baichuan/ReolinkBaichuanApi";

type Transport = "tcp" | "udp" | "auto";

interface CameraTarget {
  label: string;
  host: string;
  username: string;
  password: string;
  uid?: string;
  transport: Transport;
  isBattery: boolean;
  isNvr: boolean;
  expectChannels?: number;
}

function envOr(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function buildTargets(): CameraTarget[] {
  const targets: CameraTarget[] = [];

  const tcpHost = envOr("TCP_HOST");
  if (tcpHost) {
    targets.push({
      label: "TCP wired (TCP_HOST)",
      host: tcpHost,
      username: envOr("TCP_USERNAME") ?? "admin",
      password: envOr("TCP_PASSWORD") ?? "",
      transport: "tcp",
      isBattery: false,
      isNvr: false,
    });
  }

  const tcp265Host = envOr("TCP265_HOST");
  if (tcp265Host && tcp265Host !== tcpHost) {
    targets.push({
      label: "TCP wired H265 (TCP265_HOST)",
      host: tcp265Host,
      username: envOr("TCP265_USERNAME") ?? "admin",
      password: envOr("TCP265_PASSWORD") ?? "",
      transport: "tcp",
      isBattery: false,
      isNvr: false,
    });
  }

  const udpHost = envOr("UDP_HOST");
  if (udpHost) {
    targets.push({
      label: "UDP battery via Hub (UDP_HOST)",
      host: udpHost,
      username: envOr("UDP_USERNAME") ?? "admin",
      password: envOr("UDP_PASSWORD") ?? "",
      ...(envOr("UDP_UID") ? { uid: envOr("UDP_UID") } : {}),
      transport: "udp",
      isBattery: true,
      isNvr: false,
    });
  }

  const udpStandHost = envOr("UDP_STANDALONE_HOST");
  if (udpStandHost) {
    targets.push({
      label: "UDP battery STANDALONE (UDP_STANDALONE_HOST)",
      host: udpStandHost,
      username: envOr("UDP_STANDALONE_USERNAME") ?? "admin",
      password: envOr("UDP_STANDALONE_PASSWORD") ?? "",
      ...(envOr("UDP_STANDALONE_UID")
        ? { uid: envOr("UDP_STANDALONE_UID") }
        : {}),
      transport: "udp",
      isBattery: true,
      isNvr: false,
    });
  }

  const udpSleepHost = envOr("UDP_SLEEP_HOST");
  if (udpSleepHost) {
    targets.push({
      label: "UDP sleep-prone (UDP_SLEEP_HOST)",
      host: udpSleepHost,
      username: envOr("UDP_SLEEP_USERNAME") ?? "admin",
      password: envOr("UDP_SLEEP_PASSWORD") ?? "",
      ...(envOr("UDP_SLEEP_UID") ? { uid: envOr("UDP_SLEEP_UID") } : {}),
      transport: "udp",
      isBattery: true,
      isNvr: false,
    });
  }

  const nvrHost = envOr("NVR_HOST");
  if (nvrHost) {
    targets.push({
      label: "NVR / Home Hub (NVR_HOST)",
      host: nvrHost,
      username: envOr("NVR_USERNAME") ?? "admin",
      password: envOr("NVR_PASSWORD") ?? "",
      ...(envOr("NVR_UID") ? { uid: envOr("NVR_UID") } : {}),
      transport: "tcp",
      isBattery: false,
      isNvr: true,
    });
  }

  const hubHost = envOr("HUB_HOST");
  if (hubHost) {
    targets.push({
      label: "Hub (HUB_HOST)",
      host: hubHost,
      username: envOr("HUB_USERNAME") ?? "admin",
      password: envOr("HUB_PASSWORD") ?? "",
      transport: "tcp",
      isBattery: false,
      isNvr: true,
    });
  }

  return targets;
}

interface StepResult {
  step: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

interface CameraResult {
  label: string;
  host: string;
  steps: StepResult[];
  ok: boolean;
}

async function timed<T>(
  step: string,
  fn: () => Promise<T>,
): Promise<{ result: StepResult; value?: T }> {
  const start = Date.now();
  try {
    const value = await fn();
    return {
      result: { step, ok: true, ms: Date.now() - start },
      value,
    };
  } catch (e) {
    return {
      result: {
        step,
        ok: false,
        ms: Date.now() - start,
        detail: (e as { message?: string })?.message ?? String(e),
      },
    };
  }
}

async function runOne(target: CameraTarget): Promise<CameraResult> {
  const steps: StepResult[] = [];
  const api = new ReolinkBaichuanApi({
    host: target.host,
    port: 9000,
    username: target.username,
    password: target.password,
    ...(target.uid ? { uid: target.uid } : {}),
    transport: target.transport,
  });

  // 1. login
  const login = await timed("login", () => api.login());
  steps.push(login.result);
  if (!login.result.ok) {
    return { label: target.label, host: target.host, steps, ok: false };
  }

  // 2. ping (lightweight liveness)
  steps.push((await timed("ping", () => api.ping())).result);

  // 3. getChannelCount (sanity for NVR/Hub vs single cam)
  const chCount = await timed("getChannelCount", () => api.getChannelCount());
  steps.push(chCount.result);

  // 4. getInfo
  const info = await timed("getInfo", () => api.getInfo());
  steps.push({
    ...info.result,
    detail: info.value
      ? `model=${info.value.type} firmware=${info.value.firmVer ?? "?"}`
      : info.result.detail,
  });

  // 5. setIsNvr based on detected channels
  if (chCount.value !== undefined) {
    const isNvr = target.isNvr || chCount.value > 1;
    api.setIsNvr(isNvr);
  }

  // 6. battery: simulate idle disconnect → ensureConnected reconnect path
  if (target.isBattery) {
    const close = await timed("client.close (simulate idle disconnect)", () =>
      api.client.close(),
    );
    steps.push(close.result);

    // ensureConnected re-opens the BCUDP socket (or BCTCP). This is exactly
    // what the rtsp-manager getOrCreateApiConnection reuse path relies on.
    const reconn = await timed("ensureConnected (post idle)", () =>
      api.ensureConnected(),
    );
    steps.push(reconn.result);

    if (reconn.result.ok) {
      steps.push((await timed("ping (post-reconnect)", () => api.ping())).result);
    }
  }

  // Cleanup
  try {
    await api.close();
  } catch {
    // ignore
  }

  const ok = steps.every((s) => s.ok);
  return { label: target.label, host: target.host, steps, ok };
}

function formatResult(r: CameraResult): string {
  const header = `${r.ok ? "PASS" : "FAIL"}  ${r.label}  [${r.host}]`;
  const lines = r.steps.map((s) => {
    const tag = s.ok ? "ok " : "FAIL";
    const detail = s.detail ? `  — ${s.detail}` : "";
    return `    ${tag}  ${s.step.padEnd(40)} ${String(s.ms).padStart(6)}ms${detail}`;
  });
  return [header, ...lines].join("\n");
}

async function main(): Promise<void> {
  const targets = buildTargets();
  if (targets.length === 0) {
    console.error("No camera targets in .env. Configure at least one *_HOST.");
    process.exit(1);
  }

  console.log(`\nConnectivity smoke test — ${targets.length} target(s)\n`);

  const results: CameraResult[] = [];
  for (const t of targets) {
    console.log(`-> ${t.label} (${t.host}, ${t.transport}${t.isBattery ? ", battery" : ""})`);
    const r = await runOne(t);
    results.push(r);
    console.log(formatResult(r));
    console.log("");
  }

  const failed = results.filter((r) => !r.ok);
  console.log("=".repeat(60));
  console.log(
    `Summary: ${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length > 0) {
    console.log("Failed targets:");
    for (const f of failed) {
      const failedSteps = f.steps
        .filter((s) => !s.ok)
        .map((s) => `${s.step}: ${s.detail ?? "?"}`);
      console.log(`  - ${f.label} [${f.host}] :: ${failedSteps.join(" | ")}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("Smoke test crashed:", e);
  process.exit(1);
});
