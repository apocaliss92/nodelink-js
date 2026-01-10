import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

const EXPECTED_CHANNELS = [0, 1] as const;

const EXPECTED_CHANNEL_INFO: Record<(typeof EXPECTED_CHANNELS)[number], { name: string; uid: string; state: string }> = {
  0: { name: "Videocamera lavanderia", uid: "9527000HXOHJ142G", state: "connect" },
  1: { name: "Videocamera porta retro", uid: "952700093ABW14UB", state: "connect" },
};

const FORCE_MOCK_PUSH = process.env.MOCK_PUSH === "1";

function safeNow(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

interface TestStrategy {
  name: string;
  fn: (
    api: ReolinkBaichuanApi,
    channels: number[],
    pushInfo: Map<number, { name: string; uid: string; state: string }>,
  ) => Promise<Record<number, any>>;
}

async function waitForPushChannels(params: {
  api: ReolinkBaichuanApi;
  expectedChannels: readonly number[];
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<Map<number, { name: string; uid: string; state: string }>> {
  const timeoutMs = params.timeoutMs ?? 10_000;
  const intervalMs = params.intervalMs ?? 500;
  const start = Date.now();
  let lastLogAt = 0;
  while (Date.now() - start < timeoutMs) {
    const info = params.api.getChannelInfoFromPushCache();
    const allPresent = params.expectedChannels.every((c) => info.has(c));
    if (allPresent) return info;

    const now = Date.now();
    if (now - lastLogAt > 1000) {
      lastLogAt = now;
      const available = (Array.from(info.keys()) as number[]).sort((a, b) => a - b);
      const missing = params.expectedChannels.filter((c) => !info.has(c));
      const elapsed = now - start;
      const remaining = Math.max(0, timeoutMs - elapsed);
      console.log(
        `Waiting for cmd_id 145 push... missing: ${missing.join(", ") || "none"}; available: ${available.join(", ") || "none"}; remaining: ${Math.ceil(
          remaining / 1000,
        )}s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return params.api.getChannelInfoFromPushCache();
}

function normalizeString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

async function main(): Promise<void> {
  const { host, username, password, uid } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  const api = new ReolinkBaichuanApi({
    host,
    username,
    password,
    uid,
    timeoutMs: 30_000,
  });

  console.log("Logging in...");
  await api.login();
  console.log("Login OK");

  // Assumption for this test run: only channels 0 and 1 are present
  const channels: number[] = Array.from(EXPECTED_CHANNELS);

  let channelInfoFromPush: Map<number, { name: string; uid: string; state: string }>;
  if (FORCE_MOCK_PUSH) {
    console.warn("MOCK_PUSH=1: using EXPECTED_CHANNEL_INFO as push mock (skipping cmd_id 145 wait)");
    channelInfoFromPush = new Map<number, { name: string; uid: string; state: string }>(
      channels.map((c) => [c, EXPECTED_CHANNEL_INFO[c as 0 | 1]]),
    );
  } else {
    console.log(`Expecting channels from push: ${channels.join(", ")}`);
    const info = await waitForPushChannels({
      api,
      expectedChannels: channels,
      timeoutMs: 10_000,
      intervalMs: 500,
    });

    const missing = channels.filter((c) => !info.has(c));
    if (missing.length > 0) {
      const available = (Array.from(info.keys()) as number[]).sort((a, b) => a - b);
      console.warn(
        `cmd_id 145 push did not provide expected channels: ${missing.join(", ")}. Available: ${available.join(", ") || "none"}. Using EXPECTED_CHANNEL_INFO as mock.`,
      );
      channelInfoFromPush = new Map<number, { name: string; uid: string; state: string }>(
        channels.map((c) => [c, EXPECTED_CHANNEL_INFO[c as 0 | 1]]),
      );
    } else {
      channelInfoFromPush = info;
    }
  }

  const channelSleepFromPush = api.getChannelSleepFromPushCache();
  if (channelSleepFromPush.size > 0) {
    const asObj: Record<number, boolean> = {};
    for (const [ch, v] of channelSleepFromPush.entries()) asObj[ch] = v;
    console.log(`Sleep status from cmd_id 145 push (loginState): ${JSON.stringify(asObj)}`);
  } else {
    console.log("Sleep status from cmd_id 145 push: (none / not reported)");
  }

  for (const channel of channels) {
    const expected = EXPECTED_CHANNEL_INFO[channel as 0 | 1];
    const actual = channelInfoFromPush.get(channel) ?? {};

    const actualName = normalizeString((actual as any).name);
    const actualUid = normalizeString((actual as any).uid);
    const actualState = normalizeString((actual as any).state);

    if (actualName !== expected.name || actualUid !== expected.uid || actualState !== expected.state) {
      throw new Error(
        `Unexpected channel ${channel} identity. Expected ${JSON.stringify(expected)}; got ${JSON.stringify({
          name: actualName,
          uid: actualUid,
          state: actualState,
        })}`,
      );
    }
  }

  console.log(`Using ${channels.length} expected channels: ${channels.join(", ")}`);

  console.log("\n" + "-".repeat(80));
  console.log("Minimal getDevicesInfo() (fast path)");
  console.log("-".repeat(80));
  {
    const t0 = Date.now();
    const minimal = await api.getDevicesInfo({ channels, timeoutMs: 5_000 });
    const dt = Date.now() - t0;
    console.log(`Completed in ${dt}ms: ${JSON.stringify(minimal, null, 2)}`);
  }

  console.log("\n" + "-".repeat(80));
  console.log("NVR device groups (multifocal detection)");
  console.log("-".repeat(80));
  {
    const grouped = await api.getNvrDeviceGroups({ channels, timeoutMs: 5_000 });
    console.log(JSON.stringify(grouped, null, 2));
  }

  console.log("\n" + "=".repeat(80));
  console.log("Testing different strategies to get device info");
  console.log("=".repeat(80) + "\n");

  // Define test strategies
  const strategies: TestStrategy[] = [
    {
      name: "Strategy 1: Only channelInfoFromPush (cached, no API calls)",
      fn: async (_api, channels, pushInfo) => {
        const pushSleep = _api.getChannelSleepFromPushCache();
        const result: Record<number, any> = {};
        for (const channel of channels) {
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            ...(typeof pushSleep.get(channel) === "boolean" ? { sleep: pushSleep.get(channel) } : {}),
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 2: channelInfoFromPush + getAbilityInfo (1 batch call for all channels)",
      fn: async (api, channels, pushInfo) => {
        const abilities = await api.getAbilityInfo();
        const pushSleep = api.getChannelSleepFromPushCache();
        const result: Record<number, any> = {};
        for (const channel of channels) {
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            ...(typeof pushSleep.get(channel) === "boolean" ? { sleep: pushSleep.get(channel) } : {}),
            abilities: abilities[channel] || abilities["Host"],
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 3: Strategy 2 + getInfo per channel (N parallel calls)",
      fn: async (api, channels, pushInfo) => {
        const abilities = await api.getAbilityInfo();
        const pushSleep = api.getChannelSleepFromPushCache();
        
        // Call getInfo in parallel for all channels
        const infoPromises = channels.map(channel => 
          api.getInfo(channel, { tags: ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"] })
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        const infoResults = await Promise.all(infoPromises);
        
        const result: Record<number, any> = {};
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i]!;
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            ...(typeof pushSleep.get(channel) === "boolean" ? { sleep: pushSleep.get(channel) } : {}),
            abilities: abilities[channel] || abilities["Host"],
            info: infoResults[i],
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 4: Strategy 3 + getAiState per channel (N parallel calls)",
      fn: async (api, channels, pushInfo) => {
        const abilities = await api.getAbilityInfo();
        const pushSleep = api.getChannelSleepFromPushCache();
        
        // Call getInfo and getAiState in parallel for all channels
        const infoPromises = channels.map(channel => 
          api.getInfo(channel, { tags: ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"] })
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        const aiPromises = channels.map(channel => 
          api.getAiState(channel)
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        
        const [infoResults, aiResults] = await Promise.all([
          Promise.all(infoPromises),
          Promise.all(aiPromises),
        ]);
        
        const result: Record<number, any> = {};
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i]!;
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            ...(typeof pushSleep.get(channel) === "boolean" ? { sleep: pushSleep.get(channel) } : {}),
            abilities: abilities[channel] || abilities["Host"],
            info: infoResults[i],
            aiState: aiResults[i],
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 5: Strategy 4 + getStreamMetadata per channel (N parallel calls, optional)",
      fn: async (api, channels, pushInfo) => {
        const abilities = await api.getAbilityInfo();
        const pushSleep = api.getChannelSleepFromPushCache();
        
        // Call getInfo, getAiState, and getStreamMetadata in parallel for all channels
        const infoPromises = channels.map(channel => 
          api.getInfo(channel, { tags: ["type", "hardwareVersion", "firmwareVersion", "itemNo", "serialNumber", "name"] })
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        const aiPromises = channels.map(channel => 
          api.getAiState(channel)
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        const streamPromises = channels.map(channel => 
          api.getStreamMetadata(channel)
            .catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }))
        );
        
        const [infoResults, aiResults, streamResults] = await Promise.all([
          Promise.all(infoPromises),
          Promise.all(aiPromises),
          Promise.all(streamPromises),
        ]);
        
        const result: Record<number, any> = {};
        for (let i = 0; i < channels.length; i++) {
          const channel = channels[i]!;
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            ...(typeof pushSleep.get(channel) === "boolean" ? { sleep: pushSleep.get(channel) } : {}),
            abilities: abilities[channel] || abilities["Host"],
            info: infoResults[i],
            aiState: aiResults[i],
            streamMetadata: streamResults[i],
          };
        }
        return result;
      },
    },
  ];

  // Run each strategy and measure performance
  const results: Array<{
    strategy: string;
    duration: number;
    data: Record<number, any>;
    apiCallCount: number;
  }> = [];

  for (const strategy of strategies) {
    console.log(`\nTesting: ${strategy.name}`);
    const startTime = Date.now();
    
    try {
      const data = await strategy.fn(api, channels, channelInfoFromPush);
      const duration = Date.now() - startTime;
      
      // Estimate API call count based on strategy
      let apiCallCount = 0;
      if (strategy.name.includes("Strategy 1")) {
        apiCallCount = 0; // Cached only
      } else if (strategy.name.includes("Strategy 2")) {
        apiCallCount = 1; // getAbilityInfo only
      } else if (strategy.name.includes("Strategy 3")) {
        apiCallCount = 1 + channels.length; // getAbilityInfo + N getInfo
      } else if (strategy.name.includes("Strategy 4")) {
        apiCallCount = 1 + channels.length * 2; // getAbilityInfo + N getInfo + N getAiState
      } else if (strategy.name.includes("Strategy 5")) {
        apiCallCount = 1 + channels.length * 3; // getAbilityInfo + N getInfo + N getAiState + N getStreamMetadata
      }
      
      results.push({
        strategy: strategy.name,
        duration,
        data,
        apiCallCount,
      });
      
      console.log(`  ✓ Completed in ${duration}ms (estimated ${apiCallCount} API calls)`);
      
      // Show summary for each channel
      for (const channel of channels) {
        const channelData = data[channel as number] || {};
        const hasInfo = !!(channelData.info && !channelData.info.error);
        const hasAi = !!(channelData.aiState && !channelData.aiState.error);
        const hasStream = !!(channelData.streamMetadata && !channelData.streamMetadata.error);
        const hasAbilities = !!channelData.abilities;
        
        console.log(`  Channel ${channel}: info=${hasInfo ? "✓" : "✗"}, ai=${hasAi ? "✓" : "✗"}, stream=${hasStream ? "✓" : "✗"}, abilities=${hasAbilities ? "✓" : "✗"}`);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error(`  ✗ Failed after ${duration}ms:`, error instanceof Error ? error.message : String(error));
      results.push({
        strategy: strategy.name,
        duration,
        data: {},
        apiCallCount: 0,
      });
    }
  }

  // Generate summary report
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY REPORT");
  console.log("=".repeat(80));
  console.log(`Total channels: ${channels.length}`);
  console.log("\nPerformance comparison:");
  console.log("-".repeat(80));
  for (const result of results) {
    const avgTimePerChannel = result.apiCallCount > 0 ? result.duration / channels.length : 0;
    console.log(`${result.strategy.substring(0, 60).padEnd(60)} | ${result.duration.toString().padStart(6)}ms | ${result.apiCallCount.toString().padStart(3)} calls | ${avgTimePerChannel.toFixed(1).padStart(6)}ms/ch`);
  }

  // Save detailed results to file
  const dir = join(process.cwd(), "test", "diagnostics-dumps");
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, `baichuan_devices_info_test_${safeNow()}.json`);
  
  const detailedResults: Record<string, any> = {};
  for (const r of results) {
    detailedResults[r.strategy] = {
      duration: r.duration,
      apiCallCount: r.apiCallCount,
      data: r.data,
    };
  }
  
  const dump = {
    meta: {
      when: new Date().toISOString(),
      host,
      channels,
      totalChannels: channels.length,
    },
    strategies: results.map(r => ({
      name: r.strategy,
      duration: r.duration,
      apiCallCount: r.apiCallCount,
      channelCount: Object.keys(r.data).length,
    })),
    detailedResults,
  };
  
  writeFileSync(outPath, JSON.stringify(dump, null, 2), "utf8");
  console.log(`\nDetailed results saved to: ${outPath}`);
  
  // Recommend best strategy
  const successfulResults = results.filter(r => Object.keys(r.data).length > 0 && r.apiCallCount > 0);
  if (successfulResults.length > 0) {
    // Find strategy with best balance of completeness and speed
    const bestStrategy = successfulResults.reduce((best, current) => {
      // Score: completeness (data richness) / (duration + apiCallCount * 100)
      // Lower score is better (faster with fewer calls but still complete)
      const currentScore = current.duration + (current.apiCallCount * 100);
      const bestScore = best.duration + (best.apiCallCount * 100);
      return currentScore < bestScore ? current : best;
    });
    
    console.log("\n" + "=".repeat(80));
    console.log("RECOMMENDED STRATEGY:");
    console.log("=".repeat(80));
    console.log(bestStrategy.strategy);
    console.log(`Duration: ${bestStrategy.duration}ms`);
    console.log(`API Calls: ${bestStrategy.apiCallCount}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

