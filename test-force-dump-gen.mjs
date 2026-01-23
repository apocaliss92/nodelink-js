#!/usr/bin/env node
/**
 * Test forzante la generazione del dump per offline sweep
 */

import { BaichuanVideoStream } from "./dist/index.js";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.enc = {
      kind: "none",
      key: Buffer.alloc(16, 0x31, 0x41, 0x59, 0x26, 0x55, 0x5a, 0x43, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00)
    };
  }

  getDebugConfig() {
    return {
      general: false,
      debugRtsp: false,
      traceNativeStream: false,
      dumpEnabled: true,
      dumpDir: "test/frames-debug/force-dump-test",
      dumpBcMedia: false,
      dumpNals: false,
    };
  }

  getTransport() {
    return "tcp";
  }

  tryDecryptBinary(buf) {
    return buf;
  }

  emit(event, data) {
    super.emit(event, data);
  }

  async sendXml(xml, opts) {
    return { responseCode: 200, body: "" };
  }

  async sendBinary(cmdId, msgNum, channelId, payload, opts) {
    return { responseCode: 200, body: "" };
  }
}

const TCP_HOST = process.env.TCP_HOST || "192.168.50.226";
const TCP_USERNAME = process.env.TCP_USERNAME || "";
const TCP_PASSWORD = process.env.TCP_PASSWORD || "";
const REPLAY_SECONDS = parseInt(process.env.REPLAY_SECONDS || "10", 10);
const REPLAY_STREAM = (process.env.REPLAY_STREAM || "mainStream");

async function main() {
  const dumpDir = "test/frames-debug/force-dump-test";
  fs.mkdirSync(dumpDir, { recursive: true });

  const client = new FakeClient();
  const stream = new BaichuanVideoStream({
    client,
    channel: 0,
    profile: REPLAY_STREAM === "subStream" ? "sub" : "main",
    cmdId: 5,
    acceptAnyStreamType: true,
    logger: {
      log: (msg) => console.log(`[FakeClient] ${msg}`),
      warn: (msg) => console.warn(`[FakeClient] ${msg}`),
      debug: (msg) => console.debug(`[FakeClient] ${msg}`),
    },
  });

  const aus = [];

  stream.on("videoAccessUnit", ({ data, isKeyframe }) => {
    aus.push({ data, isKeyframe });
    if (aus.length <= 5 || aus.length % 20 === 0) {
      console.log(`[AU] #${aus.length} key=${isKeyframe} len=${data.length}`);
    }
  });

  const startMsg = {
    header: {
      magic: Buffer.alloc(4),
      cmdId: 5,
      bodyLen: 400,
      channelId: 0,
      streamType: 0,
      msgNum: 0,
      responseCode: 0,
      messageClass: 0,
    },
    body: Buffer.alloc(0),
    extension: Buffer.alloc(0),
  };

  client.emit("push", startMsg);

  await new Promise((resolve) => setTimeout(resolve, 1000));

  for (let i = 0; i < REPLAY_SECONDS; i++) {
    const frame = {
      header: {
        magic: Buffer.alloc(4),
        cmdId: 5,
        bodyLen: 500 + Math.floor(Math.random() * 1000),
        channelId: 0,
        streamType: 0,
        msgNum: i + 1,
        responseCode: 0,
        messageClass: 0,
      },
      body: Buffer.alloc(500 + Math.floor(Math.random() * 1000), 0x00),
      extension: Buffer.alloc(0),
    };

    client.emit("push", frame);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  console.log(`\n[Done] Collected ${aus.length} access units`);
  console.log(`[Check] Dump directory: ${dumpDir}`);
  console.log(`[Files]:`);

  const files = fs.readdirSync(dumpDir);
  for (const file of files) {
    console.log(`  - ${file}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[Fatal]", err);
  process.exit(1);
});
