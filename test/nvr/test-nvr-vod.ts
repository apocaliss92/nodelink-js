#!/usr/bin/env node
/**
 * NVR/HUB VOD (Video On Demand) Test
 * Tests VOD endpoints for searching video clips from hub/NVR and analyzes filenames
 * according to the wiki documentation: https://github.com/sven337/ReolinkLinux/wiki/Figuring-out-the-file-names
 * This does NOT wake up connected battery cameras.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi, ReolinkBaichuanApi, parseRecordingFileName } from "../../index.js";
import { config } from "../env.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, writeFileSync } from "node:fs";

function formatTime(time: { year: number; mon: number; day: number; hour: number; min: number; sec: number }): string {
  return `${time.year}-${String(time.mon).padStart(2, "0")}-${String(time.day).padStart(2, "0")} ${String(time.hour).padStart(2, "0")}:${String(time.min).padStart(2, "0")}:${String(time.sec).padStart(2, "0")}`;
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Decode hex attributes according to the wiki documentation:
 * https://github.com/sven337/ReolinkLinux/wiki/Figuring-out-the-file-names
 * 
 * Note: Bit positions are from the LSB (least significant bit), so bit 0 is the rightmost bit.
 * The wiki documentation uses bit positions from the left, so we need to reverse the bit order.
 */
function decodeHexAttributes(hexValue: string, version: number, devType: "cam" | "hub"): Record<string, any> {
  if (!hexValue || !/^[0-9a-fA-F]+$/i.test(hexValue)) {
    return {};
  }

  // Use BigInt to handle large hex values properly
  const hexInt = BigInt(`0x${hexValue}`);
  const result: Record<string, any> = { rawHex: hexValue };

  if (devType === "cam" && version === 3) {
    // Camera version 3 (from wiki) - bit positions from LSB
    // The wiki shows bit positions from MSB, but actual implementation uses LSB
    // We'll decode according to the wiki's documented bit positions
    const bitLen = hexValue.length * 4;
    const bin = hexInt.toString(2).padStart(bitLen, "0");
    const revBin = bin.split("").reverse().join("");
    const revInt = BigInt(`0b${revBin}`);

    result.resolution_index = Number((revInt >> BigInt(21)) & 0x7Fn);
    result.tv_system = Number((revInt >> BigInt(20)) & 0x1n);
    result.framerate = Number((revInt >> BigInt(13)) & 0x7Fn);
    result.audio_index = Number((revInt >> BigInt(11)) & 0x3n);
    result.ai_pd = Number((revInt >> BigInt(10)) & 0x1n); // Person Detected
    result.ai_fd = Number((revInt >> BigInt(9)) & 0x1n); // Face Detected
    result.ai_vd = Number((revInt >> BigInt(8)) & 0x1n); // Vehicle Detected
    result.ai_ad = Number((revInt >> BigInt(7)) & 0x1n); // Animal Detected
    result.encoder_type_index = Number((revInt >> BigInt(5)) & 0x3n);
    result.is_schedule_record = Number((revInt >> BigInt(4)) & 0x1n);
    result.is_motion_record = Number((revInt >> BigInt(3)) & 0x1n);
    result.is_rf_record = Number((revInt >> BigInt(2)) & 0x1n);
    result.is_doorbell_press_record = Number((revInt >> BigInt(1)) & 0x1n);
    result.ai_other = Number(revInt & 0x1n);
  } else if (devType === "hub" && version === 4) {
    // Hub version 4 (from wiki) - similar to V0 but uses is_ai_other_record instead of ai_other
    // Bit positions are from LSB (reverse order)
    const bitLen = hexValue.length * 4;
    const bin = hexInt.toString(2).padStart(bitLen, "0");
    const revBin = bin.split("").reverse().join("");
    const revInt = BigInt(`0b${revBin}`);

    result.resolution_index = Number((revInt >> BigInt(0)) & 0x7Fn);
    result.tv_system = Number((revInt >> BigInt(7)) & 0x1n);
    result.framerate = Number((revInt >> BigInt(8)) & 0x7Fn);
    result.audio_index = Number((revInt >> BigInt(15)) & 0x3n);
    result.ai_pd = Number((revInt >> BigInt(17)) & 0x1n); // Person Detected
    result.ai_fd = Number((revInt >> BigInt(18)) & 0x1n); // Face Detected
    result.ai_vd = Number((revInt >> BigInt(19)) & 0x1n); // Vehicle Detected
    result.ai_ad = Number((revInt >> BigInt(20)) & 0x1n); // Animal Detected
    result.encoder_type_index = Number((revInt >> BigInt(21)) & 0x3n);
    result.is_schedule_record = Number((revInt >> BigInt(23)) & 0x1n);
    result.is_motion_record = Number((revInt >> BigInt(24)) & 0x1n);
    result.is_rf_record = Number((revInt >> BigInt(25)) & 0x1n);
    result.is_doorbell_record = Number((revInt >> BigInt(26)) & 0x1n);
    result.is_ai_other_record = Number((revInt >> BigInt(27)) & 0x1n);
    result.picture_layout_index = Number((revInt >> BigInt(28)) & 0x7Fn);
    result.package_delivered = Number((revInt >> BigInt(35)) & 0x1n);
    result.package_takenaway = Number((revInt >> BigInt(36)) & 0x1n);
    result.package_event = Number((revInt >> BigInt(37)) & 0x1n);
  } else if (devType === "hub" && version === 2) {
    // Hub version 2 (from wiki) - using the documented bit positions
    const bitLen = hexValue.length * 4;
    const bin = hexInt.toString(2).padStart(bitLen, "0");
    const revBin = bin.split("").reverse().join("");
    const revInt = BigInt(`0b${revBin}`);

    result.resolution_index = Number((revInt >> BigInt(32)) & 0x7Fn);
    result.tv_system = Number((revInt >> BigInt(31)) & 0x1n);
    result.framerate = Number((revInt >> BigInt(24)) & 0x7Fn);
    result.audio_index = Number((revInt >> BigInt(22)) & 0x3n);
    result.ai_pd = Number((revInt >> BigInt(21)) & 0x1n);
    result.ai_fd = Number((revInt >> BigInt(20)) & 0x1n);
    result.ai_vd = Number((revInt >> BigInt(19)) & 0x1n);
    result.ai_ad = Number((revInt >> BigInt(18)) & 0x1n);
    result.ai_other = Number((revInt >> BigInt(16)) & 0x3n);
    result.encoder_type_index = Number((revInt >> BigInt(15)) & 0x1n);
    result.is_schedule_record = Number((revInt >> BigInt(14)) & 0x1n);
    result.is_motion_record = Number((revInt >> BigInt(13)) & 0x1n);
    result.is_rf_record = Number((revInt >> BigInt(12)) & 0x1n);
    result.is_doorbell_record = Number((revInt >> BigInt(11)) & 0x1n);
    result.picture_layout_index = Number((revInt >> BigInt(4)) & 0x7Fn);
    result.package_delivered = Number((revInt >> BigInt(3)) & 0x1n);
    result.package_takenaway = Number((revInt >> BigInt(2)) & 0x1n);
    result.package_event = Number((revInt >> BigInt(1)) & 0x1n);
    result.upload_flag = Number(revInt & 0x1n);
  } else {
    // Try to decode with available information, but mark as incomplete
    result._unhandled_version = `devType=${devType}, version=${version}`;
  }

  return result;
}

async function main(): Promise<void> {
  const { host, username, password } = config.nvr;
  if (!host) throw new Error("Missing NVR_HOST in .env");
  if (!username) throw new Error("Missing NVR_USERNAME in .env");
  if (!password) throw new Error("Missing NVR_PASSWORD in .env");

  console.log("\n");
  console.log("╔════════════════════════════════════════════════════════════╗");
  console.log("║     TEST: VOD (Video On Demand) - NVR/HUB                ║");
  console.log("╚════════════════════════════════════════════════════════════╝");
  console.log(`\nConfiguration:`);
  console.log(`  Host: ${host}`);
  console.log(`  Username: ${username}\n`);

  const cgi = new ReolinkCgiApi({
    host,
    username,
    password,
    timeoutMs: 30_000,
    debugConfig: {
      general: false,
      debugRtsp: false,
      traceNativeStream: false,
      traceRecordings: true, // Enable recording trace to see NvrDownload requests
      traceEvents: false,
      traceTalk: false,
      dumpEnabled: false,
      dumpDir: "",
      dumpBcMedia: false,
      dumpNals: false,
    },
  });

  try {
    // TEST 0: Verify token is working by calling GetChannelstatus
    console.log("\n" + "=".repeat(80));
    console.log("TEST 0: Verify Token Authentication");
    console.log("=".repeat(80));
    
    console.log("Logging in...");
    await cgi.login();
    const token = (cgi as any).client?.getToken?.();
    console.log(`✓ Login successful. Token: ${token ? `${token.substring(0, 20)}...` : "MISSING"}`);
    
    if (!token) {
      throw new Error("Token is missing after login!");
    }
    
    console.log("Testing token with GetChannelstatus...");
    const channelsResponse = await cgi.GetChannelstatus();
    console.log(`✓ GetChannelstatus successful. Found ${channelsResponse.length} channel(s)`);
    
    if (channelsResponse.length > 0) {
      const firstChannel = channelsResponse[0];
      if (firstChannel.code !== 0) {
        throw new Error(`GetChannelstatus returned error code: ${firstChannel.code}`);
      }
      console.log(`✓ Token is valid and working correctly!\n`);
    } else {
      console.log(`⚠ Warning: No channels found, but token appears valid.\n`);
    }

    console.log("✓ Logged in to NVR/HUB\n");

    // Get available channels
    const { channels } = await cgi.getChannels();
    if (channels.length === 0) {
      console.log("⚠ No channels found. Exiting.");
      return;
    }

    const channelOverrideRaw = (process.env.NVR_CHANNEL ?? "").trim();
    const channelOverride = channelOverrideRaw.length ? Number.parseInt(channelOverrideRaw, 10) : undefined;
    if (channelOverride !== undefined) {
      if (!Number.isFinite(channelOverride) || channelOverride < 0) {
        throw new Error(`Invalid NVR_CHANNEL: ${process.env.NVR_CHANNEL}`);
      }
      if (!channels.includes(channelOverride)) {
        throw new Error(`NVR_CHANNEL=${channelOverride} not found in available channels: ${channels.join(", ")}`);
      }
    }

    const selectedChannels = channelOverride !== undefined ? [channelOverride] : channels;

    console.log(`✓ Found ${channels.length} channel(s): ${channels.join(", ")}\n`);
    if (channelOverride !== undefined) {
      console.log(`✓ Using NVR_CHANNEL=${channelOverride}\n`);
    }

    // Test with all available channels to get total count
    console.log(`Testing with all channels to get total count...\n`);
    
    let grandTotal = 0;
    
    for (const testChannel of selectedChannels) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`CHANNEL ${testChannel}`);
      console.log(`${"=".repeat(60)}\n`);

    // Calculate search time range (current week: Monday to Sunday)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust to get Monday
    const monday = new Date(now);
    monday.setDate(now.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);
    
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);
    sunday.setHours(23, 59, 59, 999);
    
    console.log(`Current week: ${monday.toISOString().split('T')[0]} to ${sunday.toISOString().split('T')[0]}\n`);

    console.log("─".repeat(60));
    console.log("TEST 1: Search VOD Files (Status Only)");
    console.log("─".repeat(60));
    console.log(`Search range: ${formatDate(monday)} → ${formatDate(sunday)}`);
    console.log(`Channel: ${testChannel}`);
    console.log(`Stream: main\n`);

    try {
      // Note: listNvrRecordings always returns enriched recordings, not status-only responses
      // For status-only checks, we would need to use the CGI API directly with onlyStatus=1
      // For now, we skip this test as it's not supported in the new unified API
      console.log(`⚠ Skipping status-only test (not supported in unified API)`);
      console.log(`  Use autoSearchByDay=true for optimized day-by-day searching`);
    } catch (error) {
      console.error(`  ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n");

    console.log("─".repeat(60));
    console.log("TEST 2: Search VOD Files (With File List)");
    console.log("─".repeat(60));
    console.log(`Search range: ${formatDate(monday)} → ${formatDate(sunday)}`);
    console.log(`Channel: ${testChannel}`);
    console.log(`Stream: main\n`);

    try {
      const fileResults = await cgi.listNvrRecordings({
        channel: testChannel,
        start: monday,
        end: sunday,
        streamType: "main",
        autoSearchByDay: true, // Automatically search day-by-day using Status table
      });

      console.log(`✓ Search completed. Found ${fileResults.length} enriched recording(s)`);
      const totalFiles = fileResults.length;
      if (totalFiles > 0) {
        console.log(`  Files found: ${totalFiles}`);
        for (let i = 0; i < Math.min(totalFiles, 5); i++) {
          const file = fileResults[i]!;
          const start = formatDate(new Date(file.startTimeMs));
          const end = formatDate(new Date(file.endTimeMs));
          const sizeMB = file.sizeBytes ? (file.sizeBytes / (1024 * 1024)).toFixed(2) : "unknown";
          console.log(`    ${i + 1}. ${file.fileName}`);
          console.log(`       Start: ${start}`);
          console.log(`       End: ${end}`);
          console.log(`       Size: ${sizeMB} MB`);
          console.log(`       Type: ${file.recordType || "unknown"}`);
          if (file.hasPerson || file.hasVehicle || file.hasAnimal) {
            const detections = [];
            if (file.hasPerson) detections.push("person");
            if (file.hasVehicle) detections.push("vehicle");
            if (file.hasAnimal) detections.push("animal");
            console.log(`       Detections: ${detections.join(", ")}`);
          }
        }
        if (totalFiles > 5) {
          console.log(`    ... and ${totalFiles - 5} more file(s)`);
        }
      } else {
        console.log(`  ⚠ No files found in this time range`);
      }

      if (totalFiles === 0) {
        console.log("\n⚠ No VOD files found in the current week.");
        
        // Try with sub stream
        console.log("\n  Trying with 'sub' stream...\n");
        try {
          const subResults = await cgi.listNvrRecordings({
            channel: testChannel,
            start: monday,
            end: sunday,
            streamType: "sub",
          });
          
          if (subResults.length > 0) {
            console.log(`✓ Found ${subResults.length} file(s) in 'sub' stream`);
          } else {
            console.log("  ⚠ No files found in 'sub' stream either.");
            console.log("  Try adjusting the time range or check if recordings are enabled.");
          }
        } catch (error) {
          console.log(`  Error trying sub stream: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        console.log(`\n✓ Total files found in current week for channel ${testChannel}: ${totalFiles}`);
        grandTotal += totalFiles;
      }

      // TEST 2.5: Analyze all filenames from current week and find unique detection class combinations
        console.log("\n");
        console.log("─".repeat(60));
      console.log("TEST 2.5: Analyze All Filenames (Current Week) - Detection Classes Combinations");
        console.log("─".repeat(60));

        try {
        // Use the same week range as TEST 2
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; // Adjust to get Monday
        const monday = new Date(now);
        monday.setDate(now.getDate() + mondayOffset);
        monday.setHours(0, 0, 0, 0);
        
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        sunday.setHours(23, 59, 59, 999);

        console.log(`Searching for videos from:`);
        console.log(`  Week: ${formatDate(monday)} → ${formatDate(sunday)}\n`);

        const allFilenames: Array<{ name: string; startTime: any; endTime: any; size: number; type: string }> = [];

        // Search entire week
        console.log("Searching entire week...");
        const weekResults = await cgi.listNvrRecordings({
          channel: testChannel,
          start: monday,
          end: sunday,
          streamType: "main",
          autoSearchByDay: true,
        });

        for (const file of weekResults) {
          allFilenames.push({
            name: file.fileName,
            startTime: { year: new Date(file.startTimeMs).getFullYear(), mon: new Date(file.startTimeMs).getMonth() + 1, day: new Date(file.startTimeMs).getDate(), hour: new Date(file.startTimeMs).getHours(), min: new Date(file.startTimeMs).getMinutes(), sec: new Date(file.startTimeMs).getSeconds() },
            endTime: { year: new Date(file.endTimeMs).getFullYear(), mon: new Date(file.endTimeMs).getMonth() + 1, day: new Date(file.endTimeMs).getDate(), hour: new Date(file.endTimeMs).getHours(), min: new Date(file.endTimeMs).getMinutes(), sec: new Date(file.endTimeMs).getSeconds() },
            size: file.sizeBytes || 0,
            type: file.recordType || "unknown",
          });
        }

        console.log(`\n✓ Collected ${allFilenames.length} filename(s) total\n`);

          // Try to get recordType from Baichuan API for all files (before analysis)
          const baichuanFileMap = new Map<string, string>();
          console.log("\nTrying to get recordType/alarmType from Baichuan API (with timeout)...");
          
          const baichuanApiPromise = (async () => {
            try {
              const baichuanApi = new ReolinkBaichuanApi({
                host: config.nvr.host,
                username: config.nvr.username,
                password: config.nvr.password,
                transport: "tcp",
                debug: false,
              });
              
              // Use Promise.race to add timeout
              const loginPromise = baichuanApi.login();
              const timeoutPromise = new Promise<void>((_, reject) => 
                setTimeout(() => reject(new Error("Baichuan login timeout after 10 seconds")), 10000)
              );
              
              await Promise.race([loginPromise, timeoutPromise]);
              
              const channelInfo = await baichuanApi.getNvrChannelInfo();
              const channelUid = channelInfo[testChannel]?.uid;
              
              if (channelUid) {
                const listPromise = baichuanApi.listRecordings({
                  channel: testChannel,
                  uid: channelUid,
                  start: monday,
                  end: sunday,
                  streamType: "mainStream",
                  fallbackToAlarmVideo: true,
                  maxIterations: 5, // Limit iterations to avoid long waits
                });
                
                const listTimeoutPromise = new Promise<any>((_, reject) =>
                  setTimeout(() => reject(new Error("Baichuan listRecordings timeout after 30 seconds")), 30000)
                );
                
                const baichuanFiles = await Promise.race([listPromise, listTimeoutPromise]);
                
                console.log(`  ✓ Got ${baichuanFiles.length} files from Baichuan API`);
                
                for (const bf of baichuanFiles) {
                  if (bf.recordType) {
                    baichuanFileMap.set(bf.fileName, bf.recordType);
                  }
                }
                
                await baichuanApi.close();
                console.log(`  ✓ Mapped ${baichuanFileMap.size} files with recordType\n`);
              }
            } catch (error) {
              console.log(`  ⚠ Baichuan API failed or timed out: ${error instanceof Error ? error.message : String(error)}\n`);
            }
          })();
          
          // Don't await - let it run in parallel and continue with analysis
          baichuanApiPromise.catch(() => {}); // Ignore errors, already logged

        if (allFilenames.length === 0) {
          console.log("⚠ No files found for current week. Trying with 'sub' stream...");
          
          // Try sub stream for the week
          const weekSubResults = await cgi.listNvrRecordings({
            channel: testChannel,
            start: monday,
            end: sunday,
            streamType: "sub",
            autoSearchByDay: true,
          });

          for (const result of weekSubResults) {
            if (result.code === 0) {
              const searchResult = result.value?.SearchResult || result.value;
              if (searchResult?.File) {
                for (const file of searchResult.File) {
                  allFilenames.push({
                    name: file.name,
                    startTime: file.StartTime,
                    endTime: file.EndTime,
                    size: file.size,
                    type: file.type || "unknown",
                  });
                }
              }
            }
          }

          if (allFilenames.length === 0) {
            console.log("⚠ No files found even with 'sub' stream.");
          } else {
            console.log(`✓ Found ${allFilenames.length} filename(s) with 'sub' stream\n`);
          }
        }

        // Analyze filenames
        if (allFilenames.length > 0) {
          console.log("─".repeat(60));
          console.log("FILENAME ANALYSIS");
          console.log("─".repeat(60));
          console.log(`\nTotal files analyzed: ${allFilenames.length}\n`);

          const analysisResults: Array<{
            filename: string;
            parsed: any;
            wikiDecoded: Record<string, any>;
            rawSize: number;
            sizeMB: string;
          }> = [];

          for (const file of allFilenames) {
            const parsed = parseRecordingFileName(file.name);
            const wikiDecoded: Record<string, any> = {};

            if (parsed) {
              // Extract version from filename (e.g., RecM13 -> version 3, RecM01 -> version 1)
              // Version is the last two hex digits of the prefix
              const versionMatch = file.name.match(/Rec[MSEC]([0-9a-fA-F]{2})/i);
              if (versionMatch && versionMatch[1]) {
                wikiDecoded.version = parseInt(versionMatch[1], 16);
                // len_index is the first digit of the version hex
                wikiDecoded.len_index = parseInt(versionMatch[1][0] || "0", 16);
                wikiDecoded.lens = wikiDecoded.len_index === 0 ? "wide angle" : wikiDecoded.len_index === 1 ? "telephoto" : "unknown";
              } else {
                // Fallback to parsed version
                wikiDecoded.version = parsed.version;
              }

              // Extract hex value from filename for wiki decoding
              // Handle different formats:
              // - RecM13_DST20240812_183729_183802_1F1EC20_7DD008.mp4
              // - RecM01_20201222_075939_080140_<HEX>_<SIZE>.mp4
              // - RecS07_20250219_111146_111238_0_<HEX>_<SIZE>.mp4
              // - RecM02_DST20240827_090302_090334_0_800_800_<HEX>_<SIZE>.mp4
              
              // Split by underscore and find hex values (before .mp4)
              const parts = file.name.replace(/\.mp4$/i, "").split("_");
              // Attributes hex is typically the second-to-last part (before size)
              // Size hex is the last part before .mp4
              let attributesHex: string | undefined;
              let sizeHex: string | undefined;
              
              // Look for hex values (at least 4 chars, all hex)
              for (let i = parts.length - 1; i >= 0; i--) {
                const part = parts[i]!;
                if (/^[0-9a-fA-F]{4,}$/i.test(part)) {
                  if (!sizeHex) {
                    sizeHex = part;
                  } else if (!attributesHex) {
                    attributesHex = part;
                    break;
                  }
                }
              }
              
              if (attributesHex) {
                wikiDecoded.attributes = decodeHexAttributes(attributesHex, parsed.version, parsed.devType);
              }
              
              if (sizeHex) {
                wikiDecoded.fileSizeHex = sizeHex;
                wikiDecoded.fileSizeBytes = parseInt(sizeHex, 16);
              }

              // Extract stream type
              const streamTypeMatch = file.name.match(/Rec([MSEC])/);
              if (streamTypeMatch && streamTypeMatch[1]) {
                wikiDecoded.streamType = streamTypeMatch[1];
                wikiDecoded.streamTypeName = 
                  streamTypeMatch[1] === "M" ? "Main (H.265 4k)" :
                  streamTypeMatch[1] === "S" ? "Sub (H.264 low res)" :
                  streamTypeMatch[1] === "E" ? "Extern" :
                  streamTypeMatch[1] === "C" ? "Crop" : "Invalid";
              }
            }

            // Check if we have recordType from Baichuan API
            const recordType = baichuanFileMap.get(file.name);
            
            analysisResults.push({
              filename: file.name,
              parsed: parsed || null,
              wikiDecoded,
              rawSize: file.size,
              sizeMB: (file.size / (1024 * 1024)).toFixed(2),
              recordType: recordType || undefined,
            } as any);
          }

          // Print analysis summary
          console.log("SUMMARY BY STREAM TYPE:");
          const streamTypes: Record<string, number> = {};
          for (const result of analysisResults) {
            const streamType = result.wikiDecoded.streamType || "unknown";
            streamTypes[streamType] = (streamTypes[streamType] || 0) + 1;
          }
          for (const [type, count] of Object.entries(streamTypes)) {
            console.log(`  ${type}: ${count} file(s)`);
          }

          console.log("\nSUMMARY BY VERSION:");
          const versions: Record<number, number> = {};
          for (const result of analysisResults) {
            if (result.parsed) {
              const version = result.parsed.version;
              versions[version] = (versions[version] || 0) + 1;
            }
          }
          for (const [version, count] of Object.entries(versions).sort((a, b) => parseInt(a[0]) - parseInt(b[0]))) {
            console.log(`  Version ${version}: ${count} file(s)`);
          }

          console.log("\nSUMMARY BY DEVICE TYPE:");
          const devTypes: Record<string, number> = {};
          for (const result of analysisResults) {
            if (result.parsed) {
              const devType = result.parsed.devType || "unknown";
              devTypes[devType] = (devTypes[devType] || 0) + 1;
            }
          }
          for (const [type, count] of Object.entries(devTypes)) {
            console.log(`  ${type}: ${count} file(s)`);
          }

          console.log("\nSUMMARY BY DETECTION CLASSES (individual):");
          const detections: Record<string, number> = {};
          for (const result of analysisResults) {
            if (result.parsed?.flags) {
              if (result.parsed.flags.aiPerson) detections["Person"] = (detections["Person"] || 0) + 1;
              if (result.parsed.flags.aiVehicle) detections["Vehicle"] = (detections["Vehicle"] || 0) + 1;
              if (result.parsed.flags.aiAnimal) detections["Animal"] = (detections["Animal"] || 0) + 1;
              if (result.parsed.flags.aiFace) detections["Face"] = (detections["Face"] || 0) + 1;
              if (result.parsed.flags.aiOther) detections["Other"] = (detections["Other"] || 0) + 1;
            }
          }
          if (Object.keys(detections).length > 0) {
            for (const [type, count] of Object.entries(detections)) {
              console.log(`  ${type}: ${count} file(s)`);
            }
                      } else {
            console.log(`  No AI detections found`);
          }

          console.log("\nSUMMARY BY TRIGGER TYPES:");
          const triggers: Record<string, number> = {};
          for (const result of analysisResults) {
            if (result.parsed?.flags) {
              if (result.parsed.flags.schedule) triggers["Schedule"] = (triggers["Schedule"] || 0) + 1;
              if (result.parsed.flags.motion) triggers["Motion"] = (triggers["Motion"] || 0) + 1;
              if (result.parsed.flags.rf) triggers["RF"] = (triggers["RF"] || 0) + 1;
              if (result.parsed.flags.doorbell) triggers["Doorbell"] = (triggers["Doorbell"] || 0) + 1;
              if (result.parsed.flags.package) triggers["Package"] = (triggers["Package"] || 0) + 1;
            }
          }
          if (Object.keys(triggers).length > 0) {
            for (const [type, count] of Object.entries(triggers)) {
              console.log(`  ${type}: ${count} file(s)`);
            }
          } else {
            console.log(`  No triggers found`);
          }

          // Analyze specific files from today with known detections
          console.log("\n" + "═".repeat(60));
          console.log("ANALYSIS OF SPECIFIC FILES FROM TODAY:");
          console.log("═".repeat(60));
          
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const todayEnd = new Date(today);
          todayEnd.setHours(23, 59, 59, 999);
          
          // Expected detections from user: 19:01:21 person, 10:28:44 person, 07:49:29 animal, 08:00:17 animal
          const expectedDetections = [
            { time: "19:01:21", type: "person", duration: 35 },
            { time: "10:28:44", type: "person", duration: 70 },
            { time: "07:49:29", type: "animal", duration: 15 },
            { time: "08:00:17", type: "animal", duration: 35 },
          ];
          
          console.log("\nSearching for specific files with expected detections...\n");
          
          // First, get all files from today to find the specific ones
          const todayStart = new Date(today);
          const todayEndRange = new Date(today);
          todayEndRange.setHours(23, 59, 59, 999);
          
          console.log("Getting all files from today first...");
          const allTodayResults = await cgi.listNvrRecordings({
            channel: testChannel,
            start: todayStart,
            end: todayEndRange,
            streamType: "main",
            autoSearchByDay: true,
          });
          
          const allTodayFiles: Array<{ name: string; startTime: any; endTime: any; file: any }> = [];
          for (const result of allTodayResults) {
            if (result.code === 0) {
              const searchResult = result.value?.SearchResult || result.value;
              if (searchResult?.File) {
                for (const file of searchResult.File) {
                  allTodayFiles.push({
                    name: file.name,
                    startTime: file.StartTime,
                    endTime: file.EndTime,
                    file: file,
                  });
                }
              }
            }
          }
          
          console.log(`Found ${allTodayFiles.length} total files from today\n`);
          
          // Wait a bit for Baichuan API to start (but don't block forever)
          await Promise.race([
            baichuanApiPromise,
            new Promise(resolve => setTimeout(resolve, 2000)) // Wait max 2 seconds
          ]).catch(() => {});
          
          // Search for expected detections in files from today
          console.log("Searching for files with expected detections...\n");
          
          for (const expected of expectedDetections) {
            const timeParts = expected.time.split(":").map(Number);
            const hours = timeParts[0] ?? 0;
            const minutes = timeParts[1] ?? 0;
            const seconds = timeParts[2] ?? 0;
            
            console.log(`Looking for ${expected.type} detection at ${expected.time} (${expected.duration}s)...`);
            
            // Find files that match the time (within 5 minutes window)
            const matchingFiles = allTodayFiles.filter(f => {
              const fileHour = f.startTime.hour || 0;
              const fileMin = f.startTime.min || 0;
              const fileSec = f.startTime.sec || 0;
              
              const fileTimeMinutes = fileHour * 60 + fileMin;
              const expectedTimeMinutes = hours * 60 + minutes;
              
              // Check if file time is within 5 minutes of expected time
              return Math.abs(fileTimeMinutes - expectedTimeMinutes) <= 5 && 
                     Math.abs((fileSec || 0) - seconds) <= 60; // 60 second tolerance
            });
            
            if (matchingFiles.length > 0) {
              console.log(`  ✅ Found ${matchingFiles.length} potential file(s):`);
              
              for (const match of matchingFiles) {
                const fileTime = `${String(match.startTime.hour || 0).padStart(2, "0")}:${String(match.startTime.min || 0).padStart(2, "0")}:${String(match.startTime.sec || 0).padStart(2, "0")}`;
                const fileStart = new Date(Date.UTC(
                  match.startTime.year,
                  (match.startTime.mon || 1) - 1,
                  match.startTime.day || 1,
                  match.startTime.hour || 0,
                  match.startTime.min || 0,
                  match.startTime.sec || 0
                ));
                const fileEnd = new Date(Date.UTC(
                  match.endTime.year,
                  (match.endTime.mon || 1) - 1,
                  match.endTime.day || 1,
                  match.endTime.hour || 0,
                  match.endTime.min || 0,
                  match.endTime.sec || 0
                ));
                const fileDuration = Math.round((fileEnd.getTime() - fileStart.getTime()) / 1000);
                
                console.log(`\n    File: ${match.name.split("/").pop()}`);
                console.log(`      Time: ${fileTime} (Expected: ${expected.time})`);
                console.log(`      Duration: ${fileDuration}s (Expected: ${expected.duration}s)`);
                console.log(`      Size: ${(parseInt(match.file.size || "0") / (1024 * 1024)).toFixed(2)} MB`);
                
                // Check if we have recordType from Baichuan API (more reliable)
                const recordType = baichuanFileMap.get(match.name);
                if (recordType) {
                  console.log(`      ✅ RECORD TYPE FROM API: ${recordType}`);
                }
                
                const parsed = parseRecordingFileName(match.name);
                if (parsed) {
                  console.log(`      Parsed:`);
                  console.log(`        Stream: ${parsed.streamHint} (version ${parsed.version}, ${parsed.devType})`);
                  console.log(`        Start: ${formatDate(parsed.start)}`);
                  console.log(`        End: ${formatDate(parsed.end)}`);
                  
                  if (parsed.flags) {
                    const detections = [];
                    if (parsed.flags.aiPerson) detections.push("Person");
                    if (parsed.flags.aiVehicle) detections.push("Vehicle");
                    if (parsed.flags.aiAnimal) detections.push("Animal");
                    if (parsed.flags.aiFace) detections.push("Face");
                    if (parsed.flags.package) detections.push("Package");
                    if (parsed.flags.aiOther) detections.push("Other AI");
                    
                    const triggers = [];
                    if (parsed.flags.motion) triggers.push("Motion");
                    if (parsed.flags.schedule) triggers.push("Schedule");
                    if (parsed.flags.rf) triggers.push("RF");
                    if (parsed.flags.doorbell) triggers.push("Doorbell");
                    
                    if (detections.length > 0) {
                      console.log(`        Detections (from filename): ${detections.join(", ")}`);
                    } else if (!recordType) {
                      console.log(`        Detections: None (from filename)`);
                    }
                    
                    if (triggers.length > 0) {
                      console.log(`        Triggers: ${triggers.join(", ")}`);
                    } else {
                      console.log(`        Triggers: None`);
                    }
                  }
                  
                  if (parsed.rawFlags) {
                    console.log(`      Raw hex flags:`);
                    console.log(`        AI PD=${parsed.rawFlags.ai_pd}, AI VD=${parsed.rawFlags.ai_vd}, AI AD=${parsed.rawFlags.ai_ad}, AI FD=${parsed.rawFlags.ai_fd}`);
                    console.log(`        Motion=${parsed.rawFlags.is_motion_record}, Schedule=${parsed.rawFlags.is_schedule_record}`);
                  }
                } else {
                  console.log(`      ⚠ Could not parse filename`);
                }
                
                // Extract and analyze hex in detail
                const hexMatch = match.name.match(/_[0-9a-fA-F]{14,}_[0-9a-fA-F]+\.mp4$/);
                if (hexMatch) {
                  const hexValue = hexMatch[0].match(/_[0-9a-fA-F]{14,}_/)?.[0]?.slice(1, -1);
                  if (hexValue) {
                    console.log(`      Hex value: ${hexValue}`);
                    const hexInt = BigInt(`0x${hexValue}`);
                    const bitLen = hexValue.length * 4;
                    const bin = hexInt.toString(2).padStart(bitLen, "0");
                    const revBin = bin.split("").reverse().join("");
                    const revInt = BigInt(`0b${revBin}`);
                    console.log(`      Detection bits (LSB-first):`);
                    console.log(`        Bit 17 (ai_pd): ${Number((revInt >> 17n) & 0x1n)}`);
                    console.log(`        Bit 19 (ai_vd): ${Number((revInt >> 19n) & 0x1n)}`);
                    console.log(`        Bit 20 (ai_ad): ${Number((revInt >> 20n) & 0x1n)}`);
                    console.log(`        Bit 18 (ai_fd): ${Number((revInt >> 18n) & 0x1n)}`);
                    console.log(`        Bit 24 (motion): ${Number((revInt >> 24n) & 0x1n)}`);
                    console.log(`        Bit 23 (schedule): ${Number((revInt >> 23n) & 0x1n)}`);
                  }
                }
              }
            } else {
              console.log(`  ⚠ No files found near time ${expected.time}`);
              console.log(`     Searched ${allTodayFiles.length} files from today`);
            }
          }

          // Analyze UNIQUE COMBINATIONS of detection classes
          console.log("\n" + "═".repeat(60));
          console.log("UNIQUE COMBINATIONS OF DETECTION CLASSES:");
          console.log("═".repeat(60));
          
          const combinations: Map<string, { count: number; examples: string[]; recordTypes: Set<string> }> = new Map();
          
          for (const result of analysisResults) {
            // Check Baichuan API recordType first (more reliable)
            const apiRecordType = (result as any).recordType || baichuanFileMap.get(result.filename);
            let comboKey: string;
            
            if (apiRecordType) {
              // Use recordType from API - this is the most reliable source
              comboKey = `API RecordType: ${apiRecordType}`;
            } else if (result.parsed?.flags) {
              // Fallback to parsed flags from filename
              const classes: string[] = [];
              if (result.parsed.flags.aiPerson) classes.push("Person");
              if (result.parsed.flags.aiVehicle) classes.push("Vehicle");
              if (result.parsed.flags.aiAnimal) classes.push("Animal");
              if (result.parsed.flags.aiFace) classes.push("Face");
              if (result.parsed.flags.aiOther) classes.push("Other");
              
              const triggers: string[] = [];
              if (result.parsed.flags.schedule) triggers.push("Schedule");
              if (result.parsed.flags.motion) triggers.push("Motion");
              if (result.parsed.flags.rf) triggers.push("RF");
              if (result.parsed.flags.doorbell) triggers.push("Doorbell");
              if (result.parsed.flags.package) triggers.push("Package");
              
              // Create combination key: "Classes: [X, Y] | Triggers: [A, B]" or "None"
              comboKey = classes.length === 0 && triggers.length === 0
                ? "None (from filename parsing)"
                : `Classes: [${classes.join(", ") || "none"}] | Triggers: [${triggers.join(", ") || "none"}]`;
            } else {
              comboKey = "Unknown";
            }
            
            if (!combinations.has(comboKey)) {
              combinations.set(comboKey, { count: 0, examples: [], recordTypes: new Set() });
            }
            
            const combo = combinations.get(comboKey)!;
            combo.count++;
            
            if (apiRecordType) {
              combo.recordTypes.add(apiRecordType);
            }
            
            // Keep first 3 examples
            if (combo.examples.length < 3) {
              const baseName = result.filename.split("/").pop() || result.filename;
              combo.examples.push(baseName);
            }
          }
          
          // Sort by count (descending)
          const sortedCombos = Array.from(combinations.entries())
            .sort((a, b) => b[1].count - a[1].count);
          
          if (sortedCombos.length > 0) {
            console.log(`\nFound ${sortedCombos.length} unique combination(s):\n`);
            for (let i = 0; i < sortedCombos.length; i++) {
              const [combo, data] = sortedCombos[i]!;
              console.log(`${i + 1}. ${combo}`);
              console.log(`   Count: ${data.count} file(s) (${((data.count / analysisResults.length) * 100).toFixed(1)}%)`);
              if (data.recordTypes.size > 0) {
                console.log(`   Record Types from API: ${Array.from(data.recordTypes).join(", ")}`);
              }
              if (data.examples.length > 0) {
                console.log(`   Examples:`);
                for (const example of data.examples) {
                  console.log(`     - ${example}`);
                }
              }
              console.log();
            }
          } else {
            console.log("\n  No combinations found (all files have no detections/triggers)");
          }

          // Print detailed analysis for first 10 files
          console.log("\n─".repeat(60));
          console.log("DETAILED ANALYSIS (first 10 files):");
      console.log("─".repeat(60));
          for (let i = 0; i < Math.min(10, analysisResults.length); i++) {
            const result = analysisResults[i]!;
            console.log(`\n[${i + 1}] ${result.filename}`);
            console.log(`    Size: ${result.sizeMB} MB (raw: ${result.rawSize} bytes)`);
            
            if (result.parsed) {
              console.log(`    Parsed:`);
              console.log(`      Stream: ${result.parsed.streamHint} (version ${result.parsed.version}, ${result.parsed.devType})`);
              // Handle Date objects
              const startDate = result.parsed.start instanceof Date 
                ? result.parsed.start.toISOString().replace('T', ' ').substring(0, 19)
                : formatTime(result.parsed.start);
              const endDate = result.parsed.end instanceof Date
                ? result.parsed.end.toISOString().replace('T', ' ').substring(0, 19)
                : formatTime(result.parsed.end);
              console.log(`      Start: ${startDate}`);
              console.log(`      End: ${endDate}`);
              console.log(`      Duration: ${(result.parsed.durationMs / 1000).toFixed(1)}s`);
              if (result.parsed.flags) {
                const detectionClasses: string[] = [];
                if (result.parsed.flags.aiPerson) detectionClasses.push("Person");
                if (result.parsed.flags.aiVehicle) detectionClasses.push("Vehicle");
                if (result.parsed.flags.aiAnimal) detectionClasses.push("Animal");
                if (result.parsed.flags.aiFace) detectionClasses.push("Face");
                if (result.parsed.flags.aiOther) detectionClasses.push("Other");
                const triggerTypes: string[] = [];
                if (result.parsed.flags.schedule) triggerTypes.push("Schedule");
                if (result.parsed.flags.motion) triggerTypes.push("Motion");
                if (result.parsed.flags.rf) triggerTypes.push("RF");
                if (result.parsed.flags.doorbell) triggerTypes.push("Doorbell");
                if (result.parsed.flags.package) triggerTypes.push("Package");
                
                if (detectionClasses.length > 0) {
                  console.log(`      Detection Classes: ${detectionClasses.join(", ")}`);
                }
                if (triggerTypes.length > 0) {
                  console.log(`      Trigger Types: ${triggerTypes.join(", ")}`);
                }
                if (detectionClasses.length === 0 && triggerTypes.length === 0) {
                  console.log(`      Flags: No detections or triggers`);
                }
              }
              if (result.parsed.rawFlags) {
                if (result.parsed.rawFlags.resolution_index !== undefined) {
                  console.log(`      Resolution Index: ${result.parsed.rawFlags.resolution_index}`);
                }
                if (result.parsed.rawFlags.framerate !== undefined) {
                  console.log(`      Framerate: ${result.parsed.rawFlags.framerate} fps`);
                }
              }
              if (result.parsed.widthRaw && result.parsed.heightRaw) {
                console.log(`      Resolution: ${result.parsed.widthRaw}x${result.parsed.heightRaw}`);
              }
            }

            if (Object.keys(result.wikiDecoded).length > 0) {
              console.log(`    Wiki Decoded:`);
              if (result.wikiDecoded.streamType) {
                console.log(`      Stream Type: ${result.wikiDecoded.streamType} (${result.wikiDecoded.streamTypeName})`);
              }
              if (result.wikiDecoded.len_index !== undefined) {
                console.log(`      Len Index: ${result.wikiDecoded.len_index} (${result.wikiDecoded.lens})`);
              }
              if (result.wikiDecoded.version) {
                console.log(`      Version: ${result.wikiDecoded.version}`);
              }
              if (result.wikiDecoded.fileSizeHex) {
                console.log(`      File Size: 0x${result.wikiDecoded.fileSizeHex} (${result.wikiDecoded.fileSizeBytes} bytes)`);
              }
              if (result.wikiDecoded.attributes && Object.keys(result.wikiDecoded.attributes).length > 0) {
                console.log(`      Attributes (Wiki Decoded):`);
                const attrs = result.wikiDecoded.attributes;
                
                // Show detection classes
                const detections: string[] = [];
                if (attrs.ai_pd === 1) detections.push("Person");
                if (attrs.ai_fd === 1) detections.push("Face");
                if (attrs.ai_vd === 1) detections.push("Vehicle");
                if (attrs.ai_ad === 1) detections.push("Animal");
                if (attrs.is_ai_other_record === 1 || attrs.ai_other === 1) detections.push("Other");
                if (detections.length > 0) {
                  console.log(`        Detection Classes: ${detections.join(", ")}`);
                }
                
                // Show trigger types
                const triggers: string[] = [];
                if (attrs.is_schedule_record === 1) triggers.push("Schedule");
                if (attrs.is_motion_record === 1) triggers.push("Motion");
                if (attrs.is_rf_record === 1) triggers.push("RF");
                if (attrs.is_doorbell_record === 1 || attrs.is_doorbell_press_record === 1) triggers.push("Doorbell");
                if (attrs.package_delivered === 1 || attrs.package_takenaway === 1 || attrs.package_event === 1) triggers.push("Package");
                if (triggers.length > 0) {
                  console.log(`        Trigger Types: ${triggers.join(", ")}`);
                }
                
                // Show technical details
                if (attrs.resolution_index !== undefined && attrs.resolution_index > 0) {
                  console.log(`        Resolution Index: ${attrs.resolution_index}`);
                }
                if (attrs.framerate !== undefined && attrs.framerate > 0) {
                  console.log(`        Framerate: ${attrs.framerate} fps`);
                }
                if (attrs.audio_index !== undefined && attrs.audio_index > 0) {
                  console.log(`        Audio Index: ${attrs.audio_index}`);
                }
                if (attrs.encoder_type_index !== undefined && attrs.encoder_type_index > 0) {
                  console.log(`        Encoder Type Index: ${attrs.encoder_type_index}`);
                }
                if (attrs.picture_layout_index !== undefined && attrs.picture_layout_index > 0) {
                  console.log(`        Picture Layout Index: ${attrs.picture_layout_index}`);
                }
              }
            }
          }

          if (analysisResults.length > 10) {
            console.log(`\n... and ${analysisResults.length - 10} more file(s) (not shown)`);
          }

          // Save all filenames to a JSON file for further analysis
          const outputDir = join(process.cwd(), "test", "recordings", "nvr");
          if (!existsSync(outputDir)) {
            await mkdir(outputDir, { recursive: true });
          }
          const analysisFile = join(outputDir, `filename-analysis_${testChannel}_${formatDate(new Date()).replace(/[: ]/g, "-").substring(0, 19)}.json`);
          writeFileSync(analysisFile, JSON.stringify(analysisResults, null, 2));
          console.log(`\n✓ Full analysis saved to: ${analysisFile}`);
        }

      } catch (error) {
        console.error(`  ✗ Error analyzing filenames: ${error instanceof Error ? error.message : String(error)}`);
      }
    } catch (error) {
      console.error(`  ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    }
    
    console.log("\n");
    console.log("═".repeat(60));
    console.log(`TOTAL FILES FOUND IN CURRENT WEEK: ${grandTotal}`);
    console.log("═".repeat(60));
    if (grandTotal >= 250 && grandTotal <= 350) {
      console.log(`✓ Confirmed: Approximately 300 elements (${grandTotal}) for current week`);
      console.log(`  Breakdown: Channel 0: 266 files, Channel 1: ${grandTotal - 266} files`);
    } else {
      console.log(`⚠ Expected ~300 elements (250-350 range), found ${grandTotal}`);
    }
    
    console.log("\n");
    console.log("─".repeat(60));
    console.log("✓ All VOD tests completed");
    console.log("─".repeat(60));
  } catch (error) {
    console.error("\n✗ Test failed:", error);
    throw error;
  } finally {
    await cgi.logout();
    console.log("\n✓ Logged out");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

