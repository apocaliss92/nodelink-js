import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import { config } from "../env.js";

function safeNow(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

interface TestStrategy {
  name: string;
  fn: (api: ReolinkBaichuanApi, channels: number[]) => Promise<Record<number, any>>;
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

  await api.login();

  // Get initial channel list from push info
  const channelInfoFromPush = api.getDevicesInfo();
  const channels: number[] = Array.from(channelInfoFromPush.keys()) as number[];
  channels.sort((a, b) => a - b);

  if (channels.length === 0) {
    console.warn("No channels found from push info. Waiting 5 seconds for push messages...");
    await new Promise(resolve => setTimeout(resolve, 5000));
    const channelInfoAfterWait = api.getDevicesInfo();
    const additionalChannels: number[] = Array.from(channelInfoAfterWait.keys()) as number[];
    channels.push(...additionalChannels);
    channels.sort((a, b) => a - b);
  }

  if (channels.length === 0) {
    throw new Error("No channels found. Cannot proceed with test.");
  }

  console.log(`Found ${channels.length} channels: ${channels.join(", ")}`);
  console.log("\n" + "=".repeat(80));
  console.log("Testing different strategies to get device info");
  console.log("=".repeat(80) + "\n");

  // Define test strategies
  const strategies: TestStrategy[] = [
    {
      name: "Strategy 1: Only channelInfoFromPush (cached, no API calls)",
      fn: async (api, channels) => {
        const info = api.getDevicesInfo();
        const result: Record<number, any> = {};
        for (const channel of channels) {
          result[channel] = info.get(channel) || {};
        }
        return result;
      },
    },
    {
      name: "Strategy 2: channelInfoFromPush + getAbilityInfo (1 batch call for all channels)",
      fn: async (api, channels) => {
        const pushInfo = api.getDevicesInfo();
        const abilities = await api.getAbilityInfo();
        const result: Record<number, any> = {};
        for (const channel of channels) {
          result[channel] = {
            ...(pushInfo.get(channel) || {}),
            abilities: abilities[channel] || abilities["Host"],
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 3: Strategy 2 + getInfo per channel (N parallel calls)",
      fn: async (api, channels) => {
        const pushInfo = api.getDevicesInfo();
        const abilities = await api.getAbilityInfo();
        
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
            abilities: abilities[channel] || abilities["Host"],
            info: infoResults[i],
          };
        }
        return result;
      },
    },
    {
      name: "Strategy 4: Strategy 3 + getAiState per channel (N parallel calls)",
      fn: async (api, channels) => {
        const pushInfo = api.getDevicesInfo();
        const abilities = await api.getAbilityInfo();
        
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
      fn: async (api, channels) => {
        const pushInfo = api.getDevicesInfo();
        const abilities = await api.getAbilityInfo();
        
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
      const data = await strategy.fn(api, channels);
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

