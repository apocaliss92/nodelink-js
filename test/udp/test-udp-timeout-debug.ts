// @ts-expect-error - Path resolution at runtime
import { ReolinkBaichuanApi } from "../../index.js";
import * as dotenv from "dotenv";

// Load environment variables
dotenv.config({ path: ".env" });

const HOST = process.env.UDP_HOST || "192.168.1.100";
const USER = process.env.UDP_USERNAME || "admin";
const PASS = process.env.UDP_PASSWORD || "";
const UID = process.env.UDP_UID || "";

async function main() {
  console.log(`Connecting via broadcast discovery (UID: ${UID})...`);

  const api = new ReolinkBaichuanApi({
    host: "255.255.255.255",
    port: 9000,
    username: USER,
    password: PASS,
    uid: UID,
    transport: "udp",
    debugOptions: {
        general: true,
      traceNativeStream: true,
    }
  });

  // Listen for all debug events
  api.client.on("debug", (type: string, data: any) => {
    if (type === "rx" || type === "tx") {
        // Filter out video/audio data to keep logs readable, but keep control messages
        if (data.cmdId === 3 || data.cmdId === 4) return; 
        console.log(`[DEBUG] ${type.toUpperCase()}:`, JSON.stringify(data));
    } else {
        console.log(`[DEBUG] ${type}:`, data);
    }
  });

  try {
    await api.login();
    console.log("Logged in!");

    console.log("Starting video stream (Main Profile)...");
    await api.startVideoStream(0, "main");

    console.log("Stream started!");

    // Keep the stream running for 10 seconds to observe the timeout (usually happens at ~3s)
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log("Stopping stream...");
    await api.cleanup();
    
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await api.close();
    console.log("Disconnected");
  }
}

main().catch(console.error);
