/**
 * Bridge any video stream that emits `videoAccessUnit` / `audioFrame` / `close`
 * (a {@link BaichuanVideoStream} or a {@link ContinuousVideoStream}) into the
 * async-generator "source frame" shape consumed by the streaming pipelines
 * (RTSP fanout, WebRTC pump). This lets a single shared upstream stream feed
 * multiple consumers without each one creating its own native camera stream.
 */

export interface SourceFrame {
  audio: boolean;
  data: Buffer;
  codec: string | null;
  sampleRate: number | null;
  microseconds: number | null;
  videoType?: "H264" | "H265";
  isKeyframe?: boolean;
}

interface VideoStreamLike {
  on(event: "videoAccessUnit", listener: (au: VideoAccessUnitLike) => void): unknown;
  on(event: "audioFrame", listener: (frame: Buffer) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  off(event: "videoAccessUnit", listener: (au: VideoAccessUnitLike) => void): unknown;
  off(event: "audioFrame", listener: (frame: Buffer) => void): unknown;
  off(event: "close", listener: () => void): unknown;
}

interface VideoAccessUnitLike {
  data: Buffer;
  isKeyframe: boolean;
  videoType: "H264" | "H265";
  microseconds: number;
}

export interface SubscribeOptions {
  /** Bounded queue size; oldest frames are dropped on overflow. Default 200. */
  maxQueue?: number;
  /** Audio codec label for emitted audio frames. Default "aac". */
  audioCodec?: string;
  /** Audio sample rate for emitted audio frames. Default 8000. */
  audioSampleRate?: number;
}

/**
 * Subscribe to `stream`'s events and yield {@link SourceFrame}s until the
 * `signal` aborts or the stream emits `close`. Listeners are always removed in
 * the `finally` block, so the upstream stream is never left with dangling
 * subscriptions when a consumer detaches.
 */
export async function* subscribeVideoStreamAsSource(
  stream: VideoStreamLike,
  signal: AbortSignal,
  opts?: SubscribeOptions,
): AsyncGenerator<SourceFrame, void, unknown> {
  const maxQueue = opts?.maxQueue ?? 200;
  const audioCodec = opts?.audioCodec ?? "aac";
  const audioSampleRate = opts?.audioSampleRate ?? 8000;

  const queue: SourceFrame[] = [];
  let wake: (() => void) | null = null;
  let done = false;

  const push = (frame: SourceFrame) => {
    queue.push(frame);
    if (queue.length > maxQueue) {
      queue.splice(0, queue.length - maxQueue);
    }
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };

  const onVideo = (au: VideoAccessUnitLike) => {
    push({
      audio: false,
      data: au.data,
      codec: null,
      sampleRate: null,
      microseconds: au.microseconds,
      videoType: au.videoType,
      isKeyframe: au.isKeyframe,
    });
  };
  const onAudio = (frame: Buffer) => {
    push({
      audio: true,
      data: frame,
      codec: audioCodec,
      sampleRate: audioSampleRate,
      microseconds: null,
    });
  };
  const finish = () => {
    done = true;
    if (wake) {
      const w = wake;
      wake = null;
      w();
    }
  };
  const onAbort = () => finish();

  stream.on("videoAccessUnit", onVideo);
  stream.on("audioFrame", onAudio);
  stream.on("close", finish);
  if (signal.aborted) {
    done = true;
  } else {
    signal.addEventListener("abort", onAbort);
  }

  try {
    while (!done && !signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((resolve) => {
          wake = resolve;
          if (done || signal.aborted) {
            wake = null;
            resolve();
          }
        });
      }
    }
    // Drain buffered frames so a clean close still delivers what's queued.
    while (queue.length > 0 && !signal.aborted) {
      yield queue.shift()!;
    }
  } finally {
    stream.off("videoAccessUnit", onVideo);
    stream.off("audioFrame", onAudio);
    stream.off("close", finish);
    signal.removeEventListener("abort", onAbort);
  }
}
