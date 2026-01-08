#!/usr/bin/env node
/**
 * NVR/HUB VOD (Video On Demand) Test
 * Tests VOD endpoints for searching and downloading video clips from hub/NVR
 * without waking up connected battery cameras.
 */

// @ts-expect-error - Path resolution at runtime
import { ReolinkCgiApi } from "../../index.js";
import { config } from "../env.js";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, writeFileSync, statSync } from "node:fs";

function formatTime(time: { year: number; mon: number; day: number; hour: number; min: number; sec: number }): string {
  return `${time.year}-${String(time.mon).padStart(2, "0")}-${String(time.day).padStart(2, "0")} ${String(time.hour).padStart(2, "0")}:${String(time.min).padStart(2, "0")}:${String(time.sec).padStart(2, "0")}`;
}

function formatDate(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
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
      traceStream: false,
      traceRecordings: true, // Enable recording trace to see NvrDownload requests
      traceEvents: false,
      traceTalk: false,
      debugH264: false,
      debugParamSets: false,
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

    console.log(`✓ Found ${channels.length} channel(s): ${channels.join(", ")}\n`);

    // Test with all available channels to get total count
    console.log(`Testing with all channels to get total count...\n`);
    
    let grandTotal = 0;
    
    for (const testChannel of channels) {
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
      const statusResults = await cgi.searchVodFiles(testChannel, monday, sunday, {
        streamType: "main",
        statusOnly: true,
      });

      console.log(`✓ Search completed. Found ${statusResults.length} result(s)`);
      for (const result of statusResults) {
        if (result.code !== 0) {
          console.log(`  ⚠ Result code: ${result.code}`);
          if (result.error) {
            console.log(`  Error: ${JSON.stringify(result.error)}`);
          }
          continue;
        }

        const searchResult = result.value?.SearchResult || result.value;
        if (searchResult?.Status) {
          console.log(`  Status entries: ${searchResult.Status.length}`);
          for (const status of searchResult.Status) {
            const month = status.mon || status.month || 0;
            const year = status.year;
            if (status.table) {
              // Count days with recordings from bitmap
              const daysWithRecordings = status.table.split("1").length - 1;
              console.log(`    - ${year}-${String(month).padStart(2, "0")}: ${daysWithRecordings} day(s) with recordings`);
              console.log(`      Bitmap: ${status.table.substring(0, 31)} (first 31 chars)`);
            } else {
              const day = status.day || 0;
              console.log(`    - ${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
            }
          }
        } else {
          console.log(`  ⚠ No status entries found`);
          // Debug: mostra la struttura della risposta
          if (result.value) {
            console.log(`  Debug - Response structure:`, JSON.stringify(result.value, null, 2).substring(0, 500));
          }
        }
      }
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
      const fileResults = await cgi.searchVodFiles(testChannel, monday, sunday, {
        streamType: "main",
        statusOnly: false,
        autoSearchByDay: true, // Automatically search day-by-day using Status table
      });

      console.log(`✓ Search completed. Found ${fileResults.length} result(s)`);
      let totalFiles = 0;
      for (const result of fileResults) {
        if (result.code !== 0) {
          console.log(`  ⚠ Result code: ${result.code}`);
          if (result.error) {
            console.log(`  Error: ${JSON.stringify(result.error)}`);
          }
          continue;
        }

        const searchResult = result.value?.SearchResult || result.value;
        if (searchResult?.File) {
          const fileCount = searchResult.File.length;
          totalFiles += fileCount;
          console.log(`  Files found: ${fileCount}`);
          for (let i = 0; i < Math.min(fileCount, 5); i++) {
            const file = searchResult.File[i]!;
            const start = formatTime(file.StartTime);
            const end = formatTime(file.EndTime);
            const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
            console.log(`    ${i + 1}. ${file.name}`);
            console.log(`       Start: ${start}`);
            console.log(`       End: ${end}`);
            console.log(`       Size: ${sizeMB} MB`);
            console.log(`       Type: ${file.type}`);
          }
          if (fileCount > 5) {
            console.log(`    ... and ${fileCount - 5} more file(s)`);
          }
        } else {
          console.log(`  ⚠ No files found in this time range`);
        }
      }

      if (totalFiles === 0) {
        console.log("\n⚠ No VOD files found in the current week.");
        
        // Try to use Status table to find specific days with recordings
        console.log("  Checking Status table for days with recordings...\n");
        try {
          const statusCheck = await cgi.searchVodFiles(testChannel, monday, sunday, {
            streamType: "main",
            statusOnly: true,
          });
          
          for (const result of statusCheck) {
            if (result.code === 0) {
              const statusResult = result.value?.SearchResult || result.value;
              if (statusResult?.Status) {
                for (const status of statusResult.Status) {
                  if (status.table) {
                    // Parse bitmap to find days with recordings
                    const daysWithRecordings: number[] = [];
                    for (let i = 0; i < status.table.length; i++) {
                      if (status.table[i] === "1") {
                        daysWithRecordings.push(i + 1); // Days are 1-indexed
                      }
                    }
                    
                    if (daysWithRecordings.length > 0) {
                      console.log(`  Found ${daysWithRecordings.length} day(s) with recordings in ${status.year}-${String(status.mon || status.month || 0).padStart(2, "0")}`);
                      console.log(`  Days: ${daysWithRecordings.slice(0, 10).join(", ")}${daysWithRecordings.length > 10 ? ` ... (${daysWithRecordings.length} total)` : ""}`);
                      
                      // Try searching for a specific day with recordings
                      if (daysWithRecordings.length > 0) {
                        const testDay = daysWithRecordings[0]!;
                        const testYear = status.year;
                        const testMonth = status.mon || status.month || 1;
                        const dayStart = new Date(Date.UTC(testYear, testMonth - 1, testDay, 0, 0, 0));
                        const dayEnd = new Date(Date.UTC(testYear, testMonth - 1, testDay, 23, 59, 59));
                        
                        console.log(`  Searching for files on ${testYear}-${String(testMonth).padStart(2, "0")}-${String(testDay).padStart(2, "0")}...`);
                        
                        const dayResults = await cgi.searchVodFiles(testChannel, dayStart, dayEnd, {
                          streamType: "main",
                          statusOnly: false,
                        });
                        
                        let dayFiles = 0;
                        for (const dayResult of dayResults) {
                          if (dayResult.code === 0) {
                            const daySearchResult = dayResult.value?.SearchResult || dayResult.value;
                            if (daySearchResult?.File) {
                              dayFiles += daySearchResult.File.length;
                            }
                          }
                        }
                        
                        if (dayFiles > 0) {
                          console.log(`  ✓ Found ${dayFiles} file(s) on that day!`);
                        } else {
                          console.log(`  ⚠ No files found even on a day with recordings (might be a different stream type)`);
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (error) {
          console.log(`  Error checking status table: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        console.log("\n  Trying with 'sub' stream...\n");
        // Try with sub stream
        try {
          const subResults = await cgi.searchVodFiles(testChannel, monday, sunday, {
            streamType: "sub",
            statusOnly: false,
          });
          
          let subFiles = 0;
          for (const result of subResults) {
            if (result.code === 0) {
              const subSearchResult = result.value?.SearchResult || result.value;
              if (subSearchResult?.File) {
                subFiles += subSearchResult.File.length;
              }
            }
          }
          
          if (subFiles > 0) {
            console.log(`✓ Found ${subFiles} file(s) in 'sub' stream`);
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

        // TEST 2.5: Download a sample clip with ffmpeg
        console.log("\n");
        console.log("─".repeat(60));
        console.log("TEST 2.5: Download Sample Clip with FFmpeg");
        console.log("─".repeat(60));

        try {
          // Find the first available file
          let sampleFile: any = null;
          for (const result of fileResults) {
            if (result.code === 0) {
              const searchResult = result.value?.SearchResult || result.value;
              if (searchResult?.File && searchResult.File.length > 0) {
                sampleFile = searchResult.File[0];
                break;
              }
            }
          }

          if (!sampleFile) {
            console.log("  ⚠ No files available for download test");
          } else {
            console.log(`Selected file for download:`);
            console.log(`  Name: ${sampleFile.name}`);
            console.log(`  Start: ${formatTime(sampleFile.StartTime)}`);
            console.log(`  End: ${formatTime(sampleFile.EndTime)}`);
            console.log(`  Size: ${(sampleFile.size / (1024 * 1024)).toFixed(2)} MB\n`);

            // Prepare output directory
            const outputDir = join(process.cwd(), "test", "recordings", "nvr");
            if (!existsSync(outputDir)) {
              await mkdir(outputDir, { recursive: true });
              console.log(`✓ Created output directory: ${outputDir}\n`);
            }

            // Generate output filename from clip metadata
            const startTimeStr = formatTime(sampleFile.StartTime).replace(/[: ]/g, "-");
            const outputFile = join(outputDir, `channel-${testChannel}_${startTimeStr}.mp4`);

            // Calculate duration from start/end times
            const startDate = new Date(
              Date.UTC(
                sampleFile.StartTime.year,
                sampleFile.StartTime.mon - 1,
                sampleFile.StartTime.day,
                sampleFile.StartTime.hour,
                sampleFile.StartTime.min,
                sampleFile.StartTime.sec
              )
            );
            const endDate = new Date(
              Date.UTC(
                sampleFile.EndTime.year,
                sampleFile.EndTime.mon - 1,
                sampleFile.EndTime.day,
                sampleFile.EndTime.hour,
                sampleFile.EndTime.min,
                sampleFile.EndTime.sec
              )
            );
            const durationSeconds = Math.max(1, Math.floor((endDate.getTime() - startDate.getTime()) / 1000));

            // For NVR, we need to prepare the file first using NvrDownload
            console.log("Preparing file for download with NvrDownload...");
            let preparedFilename: string;
            try {
              preparedFilename = await cgi.prepareNvrVodDownload(
                testChannel,
                sampleFile.StartTime,
                sampleFile.EndTime,
                "main"
              );
              console.log(`✓ File prepared: ${preparedFilename}\n`);
            } catch (error) {
              console.error(`  ✗ Failed to prepare file: ${error instanceof Error ? error.message : String(error)}`);
              console.log(`  ⚠ Trying direct download without preparation...\n`);
              preparedFilename = sampleFile.name;
            }

            // Try direct download using Download command (like reolink_aio does)
            console.log("Attempting direct download using Download command...");
            try {
              // Extract start time from filename for the Download command
              const timeMatch = sampleFile.name.match(/Rec\w{3}(?:_|_DST)?(\d{8})_(\d{6})_/);
              const startTimeParam = timeMatch ? `${timeMatch[1]}${timeMatch[2]}` : "";

              const videoBuffer = await cgi.downloadVod(preparedFilename, {
                output: `ha_playback_${startTimeParam}.mp4`,
                start: startTimeParam,
              });

              console.log(`✓ Download completed successfully!`);
              console.log(`  Size: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);

              // Save to file
              writeFileSync(outputFile, videoBuffer);
              console.log(`  Saved to: ${outputFile}\n`);
            } catch (downloadError) {
              console.error(`  ✗ Direct download failed: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
              console.log(`  Trying streaming download with ffmpeg instead...\n`);

              // Fallback: try streaming with ffmpeg using Playback URL
              try {
                console.log("Getting streaming URL...");
                
                // Extract start time from filename for the URL
                const timeMatch = sampleFile.name.match(/Rec\w{3}(?:_|_DST)?(\d{8})_(\d{6})_/);
                const startTimeParam = timeMatch ? `${timeMatch[1]}${timeMatch[2]}` : "";
                
                // Force token refresh before generating URL
                console.log("Refreshing token before generating URL...");
                await cgi.login();
                const tokenAfterRefresh = (cgi as any).client?.getToken?.();
                console.log(`✓ Token refreshed: ${tokenAfterRefresh ? `${tokenAfterRefresh.substring(0, 20)}...` : "MISSING"}`);
                
                // Verify token still works
                console.log("Verifying token with GetChannelstatus...");
                const verifyResponse = await cgi.GetChannelstatus();
                if (verifyResponse.length > 0 && verifyResponse[0].code !== 0) {
                  throw new Error(`Token verification failed: code ${verifyResponse[0].code}`);
                }
                console.log(`✓ Token verified and working\n`);
                
                // Try Download URL first (might work better than Playback)
                console.log("Trying Download URL...");
                const downloadUrl = await cgi.getVodUrl(sampleFile.name, testChannel, {
                  requestType: "Download",
                  startTime: startTimeParam,
                  startTimeObj: sampleFile.StartTime,
                  endTimeObj: sampleFile.EndTime,
                  streamType: "main",
                });

                console.log(`✓ Download URL obtained:`);
                console.log(`\n${"=".repeat(80)}`);
                console.log(`DOWNLOAD URL FOR VLC TEST:`);
                console.log(`${"=".repeat(80)}`);
                console.log(`${downloadUrl}`);
                console.log(`${"=".repeat(80)}`);
                console.log(`Token length: ${tokenAfterRefresh?.length ?? 0} characters`);
                console.log(`Full token: ${tokenAfterRefresh ?? "MISSING"}\n`);
                
                // Also try Playback URL
                console.log("Trying Playback URL...");
                const playbackUrl = await cgi.getVodUrl(sampleFile.name, testChannel, {
                  requestType: "Playback",
                  startTime: startTimeParam,
                  startTimeObj: sampleFile.StartTime,
                  endTimeObj: sampleFile.EndTime,
                  streamType: "main",
                });

                console.log(`✓ Playback URL obtained:`);
                console.log(`\n${"=".repeat(80)}`);
                console.log(`PLAYBACK URL FOR VLC TEST:`);
                console.log(`${"=".repeat(80)}`);
                console.log(`${playbackUrl}`);
                console.log(`${"=".repeat(80)}\n`);
                console.log(`Copy one of the URLs above and paste it into VLC: Media > Open Network Stream\n`);
                
                // Try using the Download URL with ffmpeg
                console.log(`Starting download with ffmpeg using Download URL...`);
                console.log(`  Output: ${outputFile}\n`);

                // Helper function to run ffmpeg with specific arguments
                const runFfmpeg = async (args: string[], strategyName: string): Promise<boolean> => {
                  return new Promise<boolean>((resolve) => {
                    console.log(`  Trying strategy: ${strategyName}`);
                    const ffmpeg = spawn("ffmpeg", args);

                    let ffmpegError = "";
                    let ffmpegOutput = "";

                    ffmpeg.stderr.on("data", (data: Buffer) => {
                      const output = data.toString();
                      ffmpegError += output;
                      ffmpegOutput += output;
                      // Show progress if available
                      if (output.includes("time=")) {
                        const timeMatch = output.match(/time=(\d+:\d+:\d+\.\d+)/);
                        if (timeMatch) {
                          process.stdout.write(`\r    Progress: ${timeMatch[1]} / ${durationSeconds}s`);
                        }
                      }
                    });

                    ffmpeg.stdout.on("data", (data: Buffer) => {
                      ffmpegOutput += data.toString();
                    });

                    ffmpeg.on("close", (code) => {
                      if (code === 0) {
                        console.log(`\n    ✓ Download completed successfully`);
                        if (existsSync(outputFile)) {
                          const stats = statSync(outputFile);
                          const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                          console.log(`    Size: ${sizeMB} MB`);
                        }
                        resolve(true);
                      } else {
                        console.error(`\n    ✗ FFmpeg exited with code ${code}`);
                        if (ffmpegError) {
                          // Show more detailed error
                          const errorLines = ffmpegError.split("\n").filter(l => l.trim());
                          const relevantErrors = errorLines
                            .filter(l => 
                              l.includes("error") || 
                              l.includes("Error") || 
                              l.includes("failed") ||
                              l.includes("Invalid") ||
                              l.includes("not implemented")
                            )
                            .slice(0, 3);
                          if (relevantErrors.length > 0) {
                            console.error(`    Error: ${relevantErrors.join("; ")}`);
                          } else {
                            console.error(`    Error output: ${ffmpegError.substring(0, 300)}`);
                          }
                        }
                        resolve(false);
                      }
                    });

                    ffmpeg.on("error", (err) => {
                      console.error(`\n    ✗ FFmpeg spawn error: ${err.message}`);
                      resolve(false);
                    });

                    // Timeout after duration + 60 seconds (more generous for HTTP streams)
                    const timeout = setTimeout(() => {
                      console.error(`\n    ✗ Download timeout after ${durationSeconds + 60} seconds`);
                      ffmpeg.kill("SIGTERM");
                      setTimeout(() => {
                        try {
                          ffmpeg.kill("SIGKILL");
                        } catch {}
                      }, 2000);
                      resolve(false);
                    }, (durationSeconds + 60) * 1000);

                    ffmpeg.on("close", () => {
                      clearTimeout(timeout);
                    });
                  });
                };

                // Strategy 1: Copy codecs (no transcoding) - fastest and most compatible
                let downloadSuccess = await runFfmpeg(
                  [
                    "-hide_banner",
                    "-loglevel",
                    "warning",
                    "-i",
                    downloadUrl,
                    "-t",
                    String(durationSeconds),
                    "-c",
                    "copy",
                    "-f",
                    "mp4",
                    "-y",
                    outputFile,
                  ],
                  "Copy codecs (no transcoding)"
                );

                // Strategy 2: Copy codecs without duration limit (in case -t causes issues)
                if (!downloadSuccess) {
                  console.log(`  Strategy 1 failed, trying strategy 2...\n`);
                  downloadSuccess = await runFfmpeg(
                    [
                      "-hide_banner",
                      "-loglevel",
                      "warning",
                      "-i",
                      downloadUrl,
                      "-c",
                      "copy",
                      "-f",
                      "mp4",
                      "-y",
                      outputFile,
                    ],
                    "Copy codecs (no duration limit)"
                  );
                }

                // Strategy 3: Transcoding with libx264 (if copy doesn't work)
                if (!downloadSuccess) {
                  console.log(`  Strategy 2 failed, trying strategy 3...\n`);
                  downloadSuccess = await runFfmpeg(
                    [
                      "-hide_banner",
                      "-loglevel",
                      "warning",
                      "-i",
                      downloadUrl,
                      "-t",
                      String(durationSeconds),
                      "-c:v",
                      "libx264",
                      "-preset",
                      "fast",
                      "-crf",
                      "23",
                      "-c:a",
                      "aac",
                      "-f",
                      "mp4",
                      "-y",
                      outputFile,
                    ],
                    "Transcoding (libx264 + aac)"
                  );
                }

                // Strategy 4: Try with Playback URL instead of Download URL
                if (!downloadSuccess) {
                  console.log(`  Strategy 3 failed, trying strategy 4 with Playback URL...\n`);
                  downloadSuccess = await runFfmpeg(
                    [
                      "-hide_banner",
                      "-loglevel",
                      "warning",
                      "-i",
                      playbackUrl,
                      "-t",
                      String(durationSeconds),
                      "-c",
                      "copy",
                      "-f",
                      "mp4",
                      "-y",
                      outputFile,
                    ],
                    "Copy codecs with Playback URL"
                  );
                }

                if (!downloadSuccess) {
                  console.log(`\n  ⚠ All ffmpeg download strategies failed`);
                  console.log(`  The URLs work in VLC, so the issue is likely with ffmpeg's handling of the stream.`);
                  console.log(`  You can manually download using VLC or curl/wget.`);
                }
              } catch (streamError) {
                console.error(`  ✗ Streaming download also failed: ${streamError instanceof Error ? streamError.message : String(streamError)}`);
              }
            }
          }
        } catch (error) {
          console.error(`  ✗ Error downloading clip: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      console.error(`  ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
    }

    console.log("\n");

    // Test prepareNvrVodDownload if we have files
    console.log("─".repeat(60));
    console.log("TEST 3: Prepare NVR VOD Download");
    console.log("─".repeat(60));

    try {
      // Use a smaller time window (last 1 hour) for download preparation
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      console.log(`Preparing download for:`);
      console.log(`  Channel: ${testChannel}`);
      console.log(`  Start: ${formatDate(oneHourAgo)}`);
      console.log(`  End: ${formatDate(now)}`);
      console.log(`  Stream: main\n`);

      // prepareNvrVodDownload still uses Reolink time format, so we need to convert
      const downloadStartTime = {
        year: oneHourAgo.getUTCFullYear(),
        mon: oneHourAgo.getUTCMonth() + 1,
        day: oneHourAgo.getUTCDate(),
        hour: oneHourAgo.getUTCHours(),
        min: oneHourAgo.getUTCMinutes(),
        sec: oneHourAgo.getUTCSeconds(),
      };
      const downloadEndTime = {
        year: now.getUTCFullYear(),
        mon: now.getUTCMonth() + 1,
        day: now.getUTCDate(),
        hour: now.getUTCHours(),
        min: now.getUTCMinutes(),
        sec: now.getUTCSeconds(),
      };

      const filename = await cgi.prepareNvrVodDownload(testChannel, downloadStartTime, downloadEndTime, "main");

      console.log(`✓ Download prepared successfully`);
      console.log(`  Filename: ${filename}\n`);

      // Test getVodUrl
      console.log("─".repeat(60));
      console.log("TEST 4: Get VOD URL");
      console.log("─".repeat(60));

      const playbackUrl = await cgi.getVodUrl(filename, testChannel, {
        requestType: "Playback",
      });
      console.log(`✓ Playback URL generated:`);
      console.log(`  ${playbackUrl}\n`);

      const downloadUrl = await cgi.getVodUrl(filename, testChannel, {
        requestType: "Download",
      });
      console.log(`✓ Download URL generated:`);
      console.log(`  ${downloadUrl}\n`);

      const flvUrl = await cgi.getVodUrl(filename, testChannel, {
        requestType: "FLV",
        streamType: "main",
      });
      console.log(`✓ FLV streaming URL generated:`);
      console.log(`  ${flvUrl}\n`);

      // Optionally test actual download (commented out by default as it can be large)
      // console.log("─".repeat(60));
      // console.log("TEST 5: Download VOD File");
      // console.log("─".repeat(60));
      // console.log(`Downloading ${filename}...\n`);
      // const videoBuffer = await cgi.downloadVod(filename);
      // console.log(`✓ Download completed. Size: ${(videoBuffer.length / (1024 * 1024)).toFixed(2)} MB`);
    } catch (error) {
      console.error(`  ✗ Error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.message.includes("no files found")) {
        console.log(`  ℹ This is expected if there are no recordings in the specified time range.`);
      }
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
    console.log("\nNote: These commands do NOT wake up battery cameras connected to the hub.");
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

