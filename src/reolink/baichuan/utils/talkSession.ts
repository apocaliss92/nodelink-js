import type { BaichuanClient } from "../../../client/BaichuanClient";
import { BC_CLASS_MODERN_24, BC_CMD_ID_TALK, BC_CMD_ID_TALK_RESET } from "../../../protocol/constants";
import { buildBinaryExtensionXml } from "../../../protocol/xml";
import type { TalkSession, TalkSessionInfo } from "../types";
import { sleepMs } from "./recordings";
import { encodeBcMediaAdpcmBlock } from "./talk";

export const createBufferedTalkSession = (params: {
  client: BaichuanClient;
  channel: number;
  channelIdOverride?: number;
  info: TalkSessionInfo;
  blocksPerPayload?: number;
  /** If true, close the underlying socket when stop() completes (for dedicated sessions). */
  closeSocketOnStop?: boolean;
}): TalkSession => {
  const { client, channel, channelIdOverride, info } = params;

  const chunks: Buffer[] = [];
  let bufferedBytes = 0;
  let closed = false;
  let pumping = false;
  let expectedStreamEndMs = Date.now();

  const enqueue = (b: Buffer): void => {
    if (b.length === 0) return;
    chunks.push(b);
    bufferedBytes += b.length;
  };

  const consume = (n: number): Buffer => {
    if (n <= 0) return Buffer.alloc(0);
    if (bufferedBytes < n) {
      throw new Error(`Internal error: consume(${n}) with bufferedBytes=${bufferedBytes}`);
    }

    if (chunks.length === 1) {
      const only = chunks[0]!;
      if (only.length === n) {
        chunks.length = 0;
        bufferedBytes = 0;
        return only;
      }
      if (only.length > n) {
        const out = only.subarray(0, n);
        chunks[0] = only.subarray(n);
        bufferedBytes -= n;
        return out;
      }
    }

    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const head = chunks[0];
      if (!head) throw new Error("Internal error: chunk queue empty");
      const take = Math.min(n - off, head.length);
      head.copy(out, off, 0, take);

      if (take === head.length) {
        chunks.shift();
      } else {
        chunks[0] = head.subarray(take);
      }
      off += take;
    }

    bufferedBytes -= n;
    return out;
  };

  const BLOCKS_PER_PAYLOAD = Math.max(1, Math.min(8, Math.floor(params.blocksPerPayload ?? 1)));

  const sendBlocks = async (blocks: Buffer[]): Promise<void> => {
    if (blocks.length === 0) return;
    if (blocks.length > BLOCKS_PER_PAYLOAD) {
      throw new Error(`Internal error: too many blocks in payload (${blocks.length})`);
    }

    const parts: Buffer[] = [];
    let samplesSent = 0;
    for (const block of blocks) {
      parts.push(encodeBcMediaAdpcmBlock(block, info.blockSize));
      samplesSent += Math.max(0, (block.length - 4) * 2 + 1);
    }

    await client.sendBinaryPayloadNoReply({
      cmdId: BC_CMD_ID_TALK,
      channel,
      ...(channelIdOverride != null ? { channelIdOverride } : {}),
      extensionXml: buildBinaryExtensionXml(channel),
      payload: Buffer.concat(parts),
      messageClass: BC_CLASS_MODERN_24,
    });

    const playLengthMs = (samplesSent / info.audioConfig.sampleRate) * 1000;

    const now = Date.now();
    if (now > expectedStreamEndMs) expectedStreamEndMs = now + playLengthMs;
    else expectedStreamEndMs += playLengthMs;

    const sleepFor = expectedStreamEndMs - Date.now();
    if (sleepFor > 0) await sleepMs(sleepFor);
  };

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (true) {
        if (bufferedBytes >= info.fullBlockSize) {
          const blocks: Buffer[] = [];
          while (blocks.length < BLOCKS_PER_PAYLOAD && bufferedBytes >= info.fullBlockSize) {
            blocks.push(consume(info.fullBlockSize));
          }
          await sendBlocks(blocks);
          continue;
        }

        if (closed) {
          if (bufferedBytes > 0) {
            const padded = Buffer.alloc(info.fullBlockSize, 0xff);
            const tail = consume(bufferedBytes);
            tail.copy(padded, 0);
            await sendBlocks([padded]);
          }
          break;
        }

        break;
      }
    } finally {
      pumping = false;
    }
  };

  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await pump();

    const remaining = expectedStreamEndMs - Date.now();
    if (remaining > 0) await sleepMs(remaining + 100);
    else await sleepMs(100);

    const frame = await client.sendFrame({
      cmdId: BC_CMD_ID_TALK_RESET,
      channel,
      ...(channelIdOverride != null ? { channelIdOverride } : {}),
      payloadXml: "",
      messageClass: BC_CLASS_MODERN_24,
    });
    if (frame.header.responseCode !== 200) {
      throw new Error(`TalkReset rejected (responseCode ${frame.header.responseCode})`);
    }

    if (params.closeSocketOnStop) {
      try {
        await client.close({ reason: "talk_session_stop" });
      } catch {
        // ignore
      }
    }
  };

  return {
    info,
    sendAudio: async (adpcm: Buffer) => {
      if (closed) throw new Error("Talk session is closed");
      if (adpcm.length === 0) return;
      enqueue(adpcm);
      await pump();
    },
    stop,
  };
};
