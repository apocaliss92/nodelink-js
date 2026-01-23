#!/usr/bin/env node
/**
 * Simple diagnostic to verify the extension key extraction modification.
 * This connects to the camera and shows available recording info.
 */
import { ReolinkBaichuanApi } from "./dist/index.js";
import "dotenv/config";

const host = process.env.TCP_HOST;
const username = process.env.TCP_USERNAME;
const password = process.env.TCP_PASSWORD;

if (!host || !password) {
  console.error("Missing TCP_HOST or TCP_PASSWORD in .env");
  process.exit(1);
}

const api = new ReolinkBaichuanApi({
  host,
  username,
  password,
  transport: "tcp",
  debug: true,
});

async function main() {
  try {
    await api.login();
    console.log("\n=== Login OK ===");
    console.log("Host:", host);
    
    // Get device info to understand camera date
    const devInfo = await api.getInfo();
    console.log("\n=== Device Info ===");
    console.log(JSON.stringify(devInfo, null, 2));
    
    // Try to get system time
    try {
      const time = await api.getTime();
      console.log("Camera time:", time);
    } catch (e) {
      console.log("Could not get camera time:", e.message);
    }
    
    // List recordings with broader range
    console.log("\n=== Trying to list recordings ===");
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 30);  // 30 days back
    
    try {
      // Try with UID first if available
      const uid = process.env.TCP_UID;
      if (uid) {
        console.log("Using UID:", uid);
        const recs = await api.listRecordings({
          channel: 0,
          uid,
          start,
          end,
          streamType: "mainStream",
          maxIterations: 10,
        });
        console.log(`Found ${recs.length} recordings`);
        if (recs.length > 0) {
          console.log("First 3 recordings:");
          for (const rec of recs.slice(0, 3)) {
            console.log(`  - ${rec.fileName} (${rec.startTime} to ${rec.endTime})`);
          }
        }
      } else {
        console.log("No TCP_UID set, trying without...");
        const events = await api.listNvrAlarmEventsViaBaichuan({
          start,
          end,
          channels: [0],
          streamType: "mainStream",
          maxIterations: 10,
        });
        console.log(`Found ${events.length} alarm events`);
        if (events.length > 0) {
          console.log("First 3 events:");
          for (const ev of events.slice(0, 3)) {
            console.log(`  - ${ev.fileName} (${ev.startTime})`);
          }
        }
      }
    } catch (e) {
      console.log("Could not list recordings:", e.message);
    }
    
    console.log("\n=== Done ===");
    
  } finally {
    await api.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
