/**
 * Live E2E sanity check for the autodetect-path GAPs (3 / 5 / 6).
 *
 * Reads camera configs from .env and runs `autoDetectDeviceType` against
 * each one. For every camera it reports:
 *
 *   - wall-clock from kickoff to first result
 *   - transport (`tcp` vs `udp`)
 *   - UDP discovery method (if udp)
 *   - device type / model
 *   - whether the cloud server-binding lookup contributed a hint
 *
 * Run with:
 *
 *   npx tsx test/e2e-autodetect-local.ts
 *
 * Skips cameras whose host is unreachable rather than failing the whole
 * run. This is a diagnostic tool, not an assertion harness.
 */

import { config as loadDotenv } from "dotenv";
import { autoDetectDeviceType } from "../src/reolink/autodetect";
import { getServerBinding, pickP2pHostFromBinding } from "../src/cloud/server-binding";

loadDotenv();

interface CameraTarget {
  label: string;
  host: string | undefined;
  username: string | undefined;
  password: string | undefined;
  uid?: string | undefined;
}

const TARGETS: CameraTarget[] = [
  {
    label: "TCP (AC, h264)",
    host: process.env.TCP_HOST,
    username: process.env.TCP_USERNAME,
    password: process.env.TCP_PASSWORD,
  },
  {
    label: "TCP-H265 (AC, h265)",
    host: process.env.TCP265_HOST,
    username: process.env.TCP265_USERNAME,
    password: process.env.TCP265_PASSWORD,
  },
  {
    label: "UDP (battery, with UID)",
    host: process.env.UDP_HOST,
    username: process.env.UDP_USERNAME,
    password: process.env.UDP_PASSWORD,
    uid: process.env.UDP_UID,
  },
  {
    label: "UDP standalone (with UID)",
    host: process.env.UDP_STANDALONE_HOST,
    username: process.env.UDP_STANDALONE_USERNAME,
    password: process.env.UDP_STANDALONE_PASSWORD,
    uid: process.env.UDP_STANDALONE_UID,
  },
  {
    label: "UDP sleep-check (battery, may be dormant)",
    host: process.env.UDP_SLEEP_HOST,
    username: process.env.UDP_SLEEP_USERNAME,
    password: process.env.UDP_SLEEP_PASSWORD,
    uid: process.env.UDP_SLEEP_UID,
  },
  {
    label: "NVR (with UID)",
    host: process.env.NVR_HOST,
    username: process.env.NVR_USERNAME,
    password: process.env.NVR_PASSWORD,
    uid: process.env.NVR_UID,
  },
  {
    label: "Hub",
    host: process.env.HUB_HOST,
    username: process.env.HUB_USERNAME,
    password: process.env.HUB_PASSWORD,
  },
  {
    label: "Doorbell (with UID)",
    host: process.env.DOORBELL_HOST,
    username: process.env.DOORBELL_USERNAME,
    password: process.env.DOORBELL_PASSWORD,
    uid: process.env.DOORBELL_UID,
  },
];

interface Row {
  label: string;
  host: string;
  outcome: "ok" | "skip" | "fail";
  ms?: number;
  transport?: string;
  udpDiscoveryMethod?: string;
  type?: string;
  model?: string;
  hint?: string;
  error?: string;
}

const banner = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const warn = (s: string) => `\x1b[33m${s}\x1b[0m`;
const err = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function probeOne(t: CameraTarget): Promise<Row> {
  if (!t.host || !t.username || !t.password) {
    return { label: t.label, host: t.host ?? "(unset)", outcome: "skip" };
  }

  // GAP-3 — try server-binding first if UID is present. Reported
  // separately so we can see whether the cloud hint contributed.
  let hint: string | undefined;
  if (t.uid) {
    const binding = await getServerBinding(t.uid).catch(() => undefined);
    hint = pickP2pHostFromBinding(binding);
  }

  const t0 = Date.now();
  try {
    const result = await autoDetectDeviceType({
      host: t.host,
      username: t.username,
      password: t.password,
      ...(t.uid ? { uid: t.uid } : {}),
      mode: "auto",
      maxRetries: 1,
      logger: {
        log: () => {}, // quiet — wall-clock only
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    const ms = Date.now() - t0;
    // Don't keep the api alive beyond the probe.
    try {
      await result.api?.close({ reason: "e2e:done" });
    } catch {
      // ignore
    }
    return {
      label: t.label,
      host: t.host,
      outcome: "ok",
      ms,
      transport: result.transport,
      ...(result.udpDiscoveryMethod
        ? { udpDiscoveryMethod: result.udpDiscoveryMethod }
        : {}),
      type: result.type,
      ...(result.deviceInfo?.type ? { model: result.deviceInfo.type } : {}),
      ...(hint ? { hint } : {}),
    };
  } catch (e) {
    const ms = Date.now() - t0;
    return {
      label: t.label,
      host: t.host,
      outcome: "fail",
      ms,
      ...(hint ? { hint } : {}),
      error: (e as { message?: string })?.message ?? String(e),
    };
  }
}

async function main(): Promise<void> {
  console.log(banner("Reolink autodetect local-E2E"));
  console.log(
    dim(
      `Running against ${TARGETS.filter((t) => t.host).length} camera(s) from .env. Quiet mode (logs suppressed).`,
    ),
  );
  console.log();

  const rows: Row[] = [];
  for (const t of TARGETS) {
    process.stdout.write(`  ${t.label}… `);
    const row = await probeOne(t);
    rows.push(row);
    if (row.outcome === "skip") {
      process.stdout.write(dim("(skip — host/creds missing)\n"));
    } else if (row.outcome === "ok") {
      const transportTag =
        row.transport === "tcp"
          ? ok(row.transport)
          : warn(`${row.transport}/${row.udpDiscoveryMethod ?? "?"}`);
      process.stdout.write(
        ok(`OK ${row.ms}ms`) +
          ` ${transportTag} type=${row.type ?? "?"}` +
          (row.model ? dim(` model=${row.model}`) : "") +
          (row.hint ? dim(` cloud-hint=${row.hint}`) : "") +
          "\n",
      );
    } else {
      process.stdout.write(
        err(`FAIL ${row.ms}ms`) +
          ` ${dim(row.error ?? "")}` +
          (row.hint ? dim(` cloud-hint=${row.hint}`) : "") +
          "\n",
      );
    }
  }

  console.log();
  const okCount = rows.filter((r) => r.outcome === "ok").length;
  const skipCount = rows.filter((r) => r.outcome === "skip").length;
  const failCount = rows.filter((r) => r.outcome === "fail").length;
  const summary = `${okCount} ok · ${skipCount} skip · ${failCount} fail`;
  console.log(banner(`Summary: ${summary}`));

  // GAP-3 telemetry
  const withHint = rows.filter((r) => r.hint).length;
  const cloudCamerasWithUid = TARGETS.filter((t) => t.uid && t.host).length;
  console.log(
    dim(
      `GAP-3 cloud server-binding: ${withHint}/${cloudCamerasWithUid} UIDs resolved to a relay hint.`,
    ),
  );

  // GAP-6 timing histogram (tcp vs udp wall-clock)
  const okRows = rows.filter((r) => r.outcome === "ok" && r.ms != null);
  const tcpRows = okRows.filter((r) => r.transport === "tcp");
  const udpRows = okRows.filter((r) => r.transport === "udp");
  if (tcpRows.length > 0) {
    const avgTcp =
      tcpRows.reduce((acc, r) => acc + (r.ms ?? 0), 0) / tcpRows.length;
    console.log(dim(`TCP cameras: avg ${avgTcp.toFixed(0)}ms (n=${tcpRows.length}).`));
  }
  if (udpRows.length > 0) {
    const avgUdp =
      udpRows.reduce((acc, r) => acc + (r.ms ?? 0), 0) / udpRows.length;
    console.log(dim(`UDP cameras: avg ${avgUdp.toFixed(0)}ms (n=${udpRows.length}).`));
  }

  if (failCount > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(err(`Uncaught: ${(e as { stack?: string })?.stack ?? String(e)}`));
  process.exit(2);
});
