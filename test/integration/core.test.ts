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

const assertNonEmptyString = (value: string, label: string): void => {
  assert.ok(value.trim().length > 0, `${label} must be non-empty`);
};

const runCoreReadOnlyChecks = async (params: {
  // Dynamically loaded runtime API; keep typing loose.
  api: any;
  dev: DeviceConfigBase;
  timeoutMs: number;
}): Promise<void> => {
  const { api, dev, timeoutMs } = params;
  const channel = resolveChannel(dev);

  await api.ping();

  const ports = await api.getPorts();
  assert.equal(typeof ports, "object");

  const hostInfo = await api.getInfo(undefined, { timeoutMs });
  assert.equal(typeof hostInfo, "object");

  // If present, these should usually be strings.
  if (typeof hostInfo.type === "string") assertNonEmptyString(hostInfo.type, "hostInfo.type");
  if (typeof hostInfo.name === "string") assertNonEmptyString(hostInfo.name, "hostInfo.name");

  // Best-effort; allowed to be undefined.
  await api.getNetworkInfo(undefined, { timeoutMs });

  // These might be unsupported on some firmwares; keep them best-effort.
  await api.getSupportInfo().catch(() => undefined);
  await api.getAbilityInfo().catch(() => undefined);

  const identity = await api.getChannelIdentity(channel, { timeoutMs });
  assert.equal(identity.channel, channel);

  // Model/name can be empty on some firmwares; just ensure they are strings.
  assert.equal(typeof identity.model, "string");
  assert.equal(typeof identity.name, "string");

  await api.getChannelInfo(channel, { timeoutMs });

  // Enc XML is a good "is the channel reachable" signal.
  const encXml = await api.getEncXml(channel, { timeoutMs });
  assertNonEmptyString(encXml, "encXml");

  await api.getStreamMetadata(channel);

  // Capabilities without probing keeps it read-only and predictable.
  await api.getDeviceCapabilities(channel, { probe: false, probeSiren: false, probeFloodlight: false });
};

const hasAnyDeviceConfigured = (cfg: IntegrationConfig): boolean => {
  return Boolean(cfg.standalone?.tcp || cfg.standalone?.udp || cfg.nvr);
};

test("integration/core: devices", async (t) => {
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
  if (tcp && isSuiteEnabled(tcp, "core")) {
    await t.test(
      `standalone/tcp (${tcp.host})`,
      { timeout: Math.max(resolveCreds(cfg, tcp).timeoutMs * 8, 90_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, tcp);
        const api = createTcpApi({ dev: tcp as StandaloneTcpDeviceConfig, username, password });
        try {
          await runCoreReadOnlyChecks({ api, dev: tcp, timeoutMs });
        } finally {
          await closeApi(api);
        }
      },
    );
  }

  const udp = cfg.standalone?.udp;
  if (udp && isSuiteEnabled(udp, "core")) {
    await t.test(
      `standalone/udp (${udp.host})`,
      { timeout: Math.max(resolveCreds(cfg, udp).timeoutMs * 10, 120_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, udp);
        const api = createUdpApi({ dev: udp as StandaloneUdpDeviceConfig, username, password });
        try {
          await runCoreReadOnlyChecks({ api, dev: udp, timeoutMs });
        } finally {
          await closeApi(api);
        }
      },
    );
  }

  const nvr = cfg.nvr;
  if (nvr && isSuiteEnabled(nvr, "core")) {
    await t.test(
      `nvr/tcp (${nvr.host})`,
      { timeout: Math.max(resolveCreds(cfg, nvr).timeoutMs * 12, 150_000) },
      async () => {
        const { username, password, timeoutMs } = resolveCreds(cfg, nvr);
        const api = createTcpApi({ dev: nvr as NvrDeviceConfig, username, password });
        try {
          await runCoreReadOnlyChecks({ api, dev: nvr, timeoutMs });

          // NVR-specific read-only checks.
          if (isSuiteEnabled(nvr, "nvrSummary")) {
            const summary = await api.getNvrChannelsSummary({ timeoutMs });
            assert.ok(Array.isArray(summary.channels));
            assert.ok(Array.isArray(summary.devices));
          }

          if (nvr.channels && Object.keys(nvr.channels).length > 0) {
            for (const [chStr] of Object.entries(nvr.channels)) {
              const ch = Number.parseInt(chStr, 10);
              if (!Number.isFinite(ch)) continue;
              await api.getChannelIdentity(ch, { timeoutMs });
            }
          }
        } finally {
          await closeApi(api);
        }
      },
    );
  }
});
