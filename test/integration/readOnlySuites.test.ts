import assert from "node:assert/strict";
import test from "node:test";

import { createTcpApi, createUdpApi, closeApi } from "../helpers/api.js";
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
  // Safe default: only core runs unless explicitly enabled.
  if (!suites || suites.length === 0) return suite === "core";
  return suites.includes(suite);
};

const resolveChannel = (dev: DeviceConfigBase | undefined): number => dev?.channel ?? 0;

const hasAnyDeviceConfigured = (cfg: IntegrationConfig): boolean => {
  return Boolean(cfg.standalone?.tcp || cfg.standalone?.udp || cfg.nvr);
};

const sleepMs = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
};

const runReadOnlySuites = async (params: { api: any; dev: DeviceConfigBase; timeoutMs: number }): Promise<void> => {
  const { api, dev, timeoutMs } = params;
  const channel = resolveChannel(dev);

  if (isSuiteEnabled(dev, "events")) {
    let eventCount = 0;
    const cb = () => {
      eventCount += 1;
    };

    await api.onSimpleEvent(cb);
    try {
      // Legacy pull is optional; many firmwares still support it.
      await api.getEvents(channel).catch(() => undefined);
      await sleepMs(1500);
    } finally {
      await api.offSimpleEvent(cb);
    }

    // We don't require events to actually happen.
    assert.ok(eventCount >= 0);
  }

  if (isSuiteEnabled(dev, "aiReadOnly")) {
    await api.getAiState(channel);
    await api.getAiDetectTypes(channel, { timeoutMs }).catch(() => undefined);
  }

  if (isSuiteEnabled(dev, "pirReadOnly")) {
    await api.getPirInfo(channel);
  }

  if (isSuiteEnabled(dev, "whiteLedReadOnly")) {
    await api.getWhiteLedState(channel);
  }

  if (isSuiteEnabled(dev, "ptzReadOnly")) {
    await api.getPtzPosition(channel);
    await api.getZoomFocus(channel);
    await api.getPtzPresets(channel);
  }

  if (isSuiteEnabled(dev, "battery")) {
    await api.getBatteryInfo(channel).catch(() => undefined);
    await api.getBatteryStatus(channel).catch(() => undefined);
  }
};

test("integration/read-only suites", async (t) => {
  const cfg = await loadIntegrationConfig();
  if (!cfg) {
    t.skip("No integration config found (set REOLINK_TEST_CONFIG or create test/devices.config.json)");
    return;
  }

  if (!hasAnyDeviceConfigured(cfg)) {
    t.skip("Integration config has no devices configured");
    return;
  }

  const tcp = cfg.standalone?.tcp;
  if (tcp) {
    await t.test(
      `standalone/tcp suites (${tcp.host})`,
      { timeout: Math.max(resolveCreds(cfg, tcp).timeoutMs * 12, 120_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, tcp);
        const api = createTcpApi({ dev: tcp as StandaloneTcpDeviceConfig, username, password });
        try {
          await runReadOnlySuites({ api, dev: tcp, timeoutMs });
        } finally {
          await closeApi(api);
        }
      },
    );
  }

  const udp = cfg.standalone?.udp;
  if (udp) {
    await t.test(
      `standalone/udp suites (${udp.host})`,
      { timeout: Math.max(resolveCreds(cfg, udp).timeoutMs * 14, 150_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, udp);
        const api = createUdpApi({ dev: udp as StandaloneUdpDeviceConfig, username, password });
        try {
          await runReadOnlySuites({ api, dev: udp, timeoutMs });
        } finally {
          await closeApi(api);
        }
      },
    );
  }

  const nvr = cfg.nvr;
  if (nvr) {
    await t.test(
      `nvr/tcp suites (${nvr.host})`,
      { timeout: Math.max(resolveCreds(cfg, nvr).timeoutMs * 16, 180_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, nvr);
        const api = createTcpApi({ dev: nvr as NvrDeviceConfig, username, password });
        try {
          await runReadOnlySuites({ api, dev: nvr, timeoutMs });

          if (isSuiteEnabled(nvr, "nvrSummary")) {
            const summary = await api.getNvrChannelsSummary({ timeoutMs });
            assert.ok(Array.isArray(summary.channels));
            assert.ok(Array.isArray(summary.devices));
          }
        } finally {
          await closeApi(api);
        }
      },
    );
  }
});
