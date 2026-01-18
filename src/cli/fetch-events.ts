import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { BaichuanClient } from "../client/BaichuanClient";
import { ReolinkBaichuanApi } from "../reolink/baichuan/ReolinkBaichuanApi";
import { RecordingFile } from "../reolink/baichuan/types";

// Load environment variables
dotenv.config();

async function main() {
  const host = process.env.NVR_HOST || process.env.TCP_HOST;
  const username = process.env.TCP_USERNAME || "admin";
  const password = process.env.TCP_PASSWORD || "";

  if (!host) {
    console.error("Error: NVR_HOST or TCP_HOST must be set in .env");
    process.exit(1);
  }

  console.log(`Connecting to ${host}...`);

  // Setup client options
  const options = {
    host,
    username,
    password,
    transport: "tcp" as const, // Default to TCP for NVR/HomeHub
    logger: console,
  };

  // create api instance with options
  const api = new ReolinkBaichuanApi(options);
  const client = api.client;

  try {
    await client.login();
    console.log("Logged in successfully.");

    // Target Channel 0 (usually the main view or first camera)
    const channel = 0;

    // We need the UID for the channel to query recordings.
    // Fetch device info to find the UID for channel 0.
    console.log("Fetching device info to find UID...");
    const summary = await api.getNvrChannelsSummary();
    const devices = summary.devices;
    const targetDevice = devices.find((d) => d.channel === channel);
    
    // If no specific UID is found for the channel (common on some NVRs where channel UID = NVR UID),
    // we might need to use a fallback or the NVR's own identifier if known.
    // However, ReolinkBaichuanApi usually expects a valid UID for the recording search.
    const uid = targetDevice?.uid;

    if (!uid) {
      console.warn(`Warning: Could not find explicit UID for channel ${channel}. Listing might fail if UID is required.`);
      // Proceeding with empty string or potentially trying to create a fallback if needed
      // But typically HomeHub has UIDs.
    } else {
        console.log(`Targeting Channel ${channel}, UID: ${uid}`);
    }
    
    // Safe UID to pass (some APIs accept empty string if strictly strictly NVR logic, but type expects string)
    const effectiveUid = uid || "";

    // Prepare dates: Today and Yesterday
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const daysToCheck = [yesterdayStart, todayStart];

    // Ensure download directory exists
    const downloadDir = path.join(process.cwd(), "downloads");
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }

    for (const dayStart of daysToCheck) {
      const dayEnd = new Date(dayStart);
      dayEnd.setHours(23, 59, 59, 999);
      const dateStr = dayStart.toISOString().split('T')[0];

      console.log(`\n--- Processing ${dateStr} ---`);
      console.log(`Searching events from ${dayStart.toISOString()} to ${dayEnd.toISOString()}...`);

      let events: RecordingFile[] = [];
      try {
        events = await api.listRecordings({
          channel,
          uid: effectiveUid,
          start: dayStart,
          end: dayEnd,
          streamType: "mainStream", // Prefer high quality
          fallbackToAlarmVideo: true, // Important for NVRs/Hubs that might use generic alarm video search
          maxIterations: 10, // Limit pages
        });
      } catch (e) {
        console.error(`Failed to list recordings for ${dateStr}:`, e);
        continue;
      }

      console.log(`Found ${events.length} events.`);

      if (events.length === 0) {
        console.log(`No events found for ${dateStr}.`);
        continue;
      }

      // Pick the first event
      const firstEvent = events[0];
      if (!firstEvent) {
        console.log(`No valid first event for ${dateStr}.`);
        continue;
      }

      console.log(`First event: ${firstEvent.fileName} (Time: ${firstEvent.startTime})`);

      // 1. Download Video
      const vidExt = firstEvent.fileName?.endsWith(".mp4") ? ".mp4" : ".ps"; // Guess extension or use .bin
      const vidFilename = `${dateStr}_first_event${vidExt}`;
      const vidPath = path.join(downloadDir, vidFilename);

      if (fs.existsSync(vidPath)) {
        console.log(`Video ${vidFilename} already exists, skipping.`);
      } else {
        console.log(`Downloading video to ${vidPath}...`);
        try {
          const vidData = await api.downloadRecording({
            channel,
            uid: effectiveUid,
            fileName: firstEvent.fileName,
            timeoutMs: 60000 // 60s timeout
          });
          fs.writeFileSync(vidPath, vidData);
          console.log(`Video saved (${vidData.length} bytes).`);
        } catch (e) {
          console.error(`Failed to download video:`, e);
        }
      }

      // 2. Download Snapshot
      const snapFilename = `${dateStr}_first_event.jpg`;
      const snapPath = path.join(downloadDir, snapFilename);

      if (fs.existsSync(snapPath)) {
        console.log(`Snapshot ${snapFilename} already exists, skipping.`);
      } else {
        const eventStartTime = firstEvent.startTime;
        if (!eventStartTime) {
          console.log(`No start time for first event, skipping snapshot.`);
        } else {
          console.log(`Fetching snapshot for time ${eventStartTime.toISOString()} to ${snapPath}...`);
          try {
            // Fetch thumbnail using the event start time
            const snapResult = await api.fetchEventThumbnail({
              channel,
              uid: effectiveUid,
              time: eventStartTime,
              snapType: "sub", // "sub" is usually faster/more reliable for thumbnails
            });
            fs.writeFileSync(snapPath, snapResult.data);
            console.log(`Snapshot saved (${snapResult.data.length} bytes).`);
          } catch (e) {
            console.error(`Failed to fetch snapshot:`, e);
          }
        }
      }
    }

  } catch (error) {
    console.error("Fatal error:", error);
  } finally {
    client.close();
    // Force exit after a short delay to allow logs to flush, in case handle hangs
    setTimeout(() => process.exit(0), 1000);
  }
}

main();
