import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { closeApi, createTcpApi, createUdpApi } from "../helpers/api.js";
import { buildDeviceArtifactsDir, ensureFfmpegAvailable, recordDurationSeconds, recordRtspMp4 } from "../helpers/media.js";
import {
  loadIntegrationConfig,
  resolveCreds,
  type DeviceConfigBase,
  type IntegrationConfig,
  type IntegrationSuiteName,
  type NvrDeviceConfig,
  type StandaloneTcpDeviceConfig,
  type StandaloneUdpDeviceConfig,
} from "../helpers/config.js";

const isSuiteEnabled = (dev: DeviceConfigBase | undefined, suite: IntegrationSuiteName): boolean => {
  const suites = dev?.suites;
  if (!suites || suites.length === 0) return suite === "core";
  return suites.includes(suite);
};

const hasAnyDeviceConfigured = (cfg: IntegrationConfig): boolean => {
  return Boolean(cfg.standalone?.tcp || cfg.standalone?.udp || cfg.nvr);
};


type StreamProfile = "main" | "sub" | "ext";

const wantedProfiles: StreamProfile[] = ["main", "sub", "ext"];

const resolveChannelsForDevice = async (params: { api: any; dev: DeviceConfigBase; isNvr: boolean }): Promise<number[]> => {
  if (!params.isNvr) {
    return [params.dev.channel ?? 0];
  }

  const nvrDev = params.dev as NvrDeviceConfig;
  const configured = nvrDev.channels && Object.keys(nvrDev.channels).length > 0
    ? Object.keys(nvrDev.channels)
        .map((k) => Number.parseInt(k, 10))
        .filter((n) => Number.isFinite(n))
        .sort((a, b) => a - b)
    : undefined;

  if (configured && configured.length > 0) return configured;

  // Best-effort fallback: ask the API for its observed channels.
  const summary = await params.api.getNvrChannelsSummary({ timeoutMs: 15000 }).catch(() => undefined);
  const channels = Array.isArray(summary?.channels) ? (summary.channels as number[]) : [];
  return channels.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
};

const captureSnapshots = async (params: {
  api: any;
  channel: number;
  outDir: string;
  onNvr: boolean;
}): Promise<void> => {
  const snapMain = await params.api.getSnapshot(params.channel, {
    onNvr: params.onNvr,
    streamType: "main",
    timeoutMs: 20_000,
  });
  assert.ok(Buffer.isBuffer(snapMain) && snapMain.length > 0);
  await writeFile(resolve(params.outDir, `snapshot_ch${params.channel}_main.jpg`), snapMain);

  // Some devices may not support sub snapshot; keep best-effort.
  try {
    const snapSub = await params.api.getSnapshot(params.channel, {
      onNvr: params.onNvr,
      streamType: "sub",
      timeoutMs: 20_000,
    });
    if (Buffer.isBuffer(snapSub) && snapSub.length > 0) {
      await writeFile(resolve(params.outDir, `snapshot_ch${params.channel}_sub.jpg`), snapSub);
    }
  } catch {
    // ignore
  }
};

const recordProfiles = async (params: {
  api: any;
  channel: number;
  outDir: string;
  onNvr: boolean;
  seconds: number;
}): Promise<void> => {
  const opts = await params.api.buildVideoStreamOptions({
    channel: params.channel,
    onNvr: params.onNvr,
  });

  const rtspStreams: Array<{ profile?: StreamProfile; urlWithAuth?: string; url?: string }> = Array.isArray(opts?.rtspStreams)
    ? (opts.rtspStreams as any)
    : [];

  for (const profile of wantedProfiles) {
    const stream = rtspStreams.find((s) => s?.profile === profile);
    const url = stream?.urlWithAuth ?? stream?.url;
    if (!url) {
      // Not available on this device/channel
      continue;
    }

    const outFile = resolve(params.outDir, `clip_ch${params.channel}_${profile}.mp4`);
    await recordRtspMp4({ rtspUrl: url, outFile, seconds: params.seconds });
  }
};

test("integration/streams: snapshots + mp4 clips", async (t) => {
  const cfg = await loadIntegrationConfig();
  if (!cfg) {
    t.skip("No integration config found (set REOLINK_TEST_CONFIG or create test/devices.config.json)");
    return;
  }

  if (!hasAnyDeviceConfigured(cfg)) {
    t.skip("Integration config has no devices configured");
    return;
  }

  const anyStreamsEnabled = Boolean(
    (cfg.standalone?.tcp && isSuiteEnabled(cfg.standalone.tcp, "streams")) ||
      (cfg.standalone?.udp && isSuiteEnabled(cfg.standalone.udp, "streams")) ||
      (cfg.nvr && isSuiteEnabled(cfg.nvr, "streams")),
  );

  if (!anyStreamsEnabled) {
    t.skip('No devices have suite "streams" enabled');
    return;
  }

  const ffmpegOk = await ensureFfmpegAvailable();
  if (!ffmpegOk) {
    t.skip("ffmpeg not available (install it or set FFMPEG_BIN)");
    return;
  }

  const seconds = recordDurationSeconds();

  const runForDevice = async (params: {
    label: string;
    dev: DeviceConfigBase;
    apiFactory: () => any;
    onNvr: boolean;
  }): Promise<void> => {
    const { dev } = params;
    const artifactsDir = await buildDeviceArtifactsDir({ deviceLabel: params.label, host: dev.host });

    const api = params.apiFactory();
    try {
      const channels = await resolveChannelsForDevice({ api, dev, isNvr: params.onNvr });
      assert.ok(channels.length > 0, "no channels resolved for streams test");

      for (const channel of channels) {
        const chDir = resolve(artifactsDir, `channel_${channel}`);
        await mkdir(chDir, { recursive: true });

        await captureSnapshots({ api, channel, outDir: chDir, onNvr: params.onNvr });
        await recordProfiles({ api, channel, outDir: chDir, onNvr: params.onNvr, seconds });
      }
    } finally {
      await closeApi(api);
    }
  };

  const tcp = cfg.standalone?.tcp;
  if (tcp && isSuiteEnabled(tcp, "streams")) {
    await t.test(
      `standalone/tcp streams (${tcp.host})`,
      { timeout: Math.max(resolveCreds(cfg, tcp).timeoutMs * 40, 10 * 60_000) },
      async () => {
        const { username, password } = resolveCreds(cfg, tcp);
        await runForDevice({
          label: "standalone_tcp",
          dev: tcp as StandaloneTcpDeviceConfig,
          apiFactory: () => createTcpApi({ dev: tcp as StandaloneTcpDeviceConfig, username, password }),
          onNvr: false,
        });
      },
    );
  }

  const udp = cfg.standalone?.udp;
  if (udp && isSuiteEnabled(udp, "streams")) {
    await t.test(
      `standalone/udp streams (${udp.host})`,
      { timeout: Math.max(resolveCreds(cfg, udp).timeoutMs * 50, 12 * 60_000) },
      async () => {
        const { username, password } = resolveCreds(cfg, udp);
        await runForDevice({
          label: "standalone_udp",
          dev: udp as StandaloneUdpDeviceConfig,
          apiFactory: () => createUdpApi({ dev: udp as StandaloneUdpDeviceConfig, username, password }),
          onNvr: false,
        });
      },
    );
  }

  const nvr = cfg.nvr;
  if (nvr && isSuiteEnabled(nvr, "streams")) {
    await t.test(
      `nvr/tcp streams (${nvr.host})`,
      { timeout: Math.max(resolveCreds(cfg, nvr).timeoutMs * 70, 20 * 60_000) },
      async () => {
        const { username, password } = resolveCreds(cfg, nvr);
        await runForDevice({
          label: "nvr_tcp",
          dev: nvr as NvrDeviceConfig,
          apiFactory: () => createTcpApi({ dev: nvr as NvrDeviceConfig, username, password }),
          onNvr: true,
        });
      },
    );
  }
});
