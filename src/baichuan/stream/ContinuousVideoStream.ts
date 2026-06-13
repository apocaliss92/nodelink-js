// src/baichuan/stream/ContinuousVideoStream.ts
import { EventEmitter } from "node:events";
import type { BaichuanVideoStream } from "./BaichuanVideoStream";
import { PlaceholderRenderer, type CachedKeyframe, type Logger } from "./PlaceholderRenderer";
import type { PlaceholderOptions } from "./alwaysOnTypes";
import { ALWAYS_ON_DEFAULTS } from "./alwaysOnTypes";

type VideoAccessUnit = {
  data: Buffer;
  isKeyframe: boolean;
  videoType: "H264" | "H265";
  microseconds: number;
  time?: number;
};

export interface ContinuousVideoStreamOptions {
  /** Starts and returns a live BaichuanVideoStream (already `start()`ed). */
  createLiveStream: () => Promise<BaichuanVideoStream>;
  idleFps?: number;
  placeholder?: PlaceholderOptions;
  renderer?: PlaceholderRenderer;
  logger?: Logger;
}

export class ContinuousVideoStream extends EventEmitter<{
  videoAccessUnit: [VideoAccessUnit];
  additionalHeader: [unknown];
  audioFrame: [Buffer];
  error: [Error];
  close: [];
}> {
  private live: BaichuanVideoStream | null = null;
  private lastKeyframe: CachedKeyframe | null = null;
  private lastMicroseconds = 0;
  private readonly idleFps: number;
  private readonly renderer: PlaceholderRenderer;
  private readonly logger: Logger | undefined;
  private stopped = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private idlePlaceholder: Buffer | null = null;

  constructor(private readonly opts: ContinuousVideoStreamOptions) {
    super();
    this.idleFps = Math.max(0.1, opts.idleFps ?? ALWAYS_ON_DEFAULTS.idleFps);
    this.logger = opts.logger;
    const rendererArgs: { placeholder?: PlaceholderOptions; logger?: Logger } = {};
    if (opts.placeholder !== undefined) rendererArgs.placeholder = opts.placeholder;
    if (opts.logger !== undefined) rendererArgs.logger = opts.logger;
    this.renderer = opts.renderer ?? new PlaceholderRenderer(rendererArgs);
  }

  hasCachedKeyframe(): boolean {
    return this.lastKeyframe !== null;
  }

  async goLive(): Promise<void> {
    if (this.stopped || this.live) return;
    this.stopIdleLoop();
    const stream = await this.opts.createLiveStream();
    this.live = stream;
    stream.on("videoAccessUnit", this.onLiveAccessUnit);
    stream.on("additionalHeader", this.onAdditionalHeader);
    stream.on("audioFrame", this.onAudioFrame);
    stream.on("error", this.onLiveError);
    await stream.start().catch((e) => this.emit("error", e as Error));
  }

  async goIdle(): Promise<void> {
    if (!this.live) return;
    const s = this.live;
    this.live = null;
    s.off("videoAccessUnit", this.onLiveAccessUnit);
    s.off("additionalHeader", this.onAdditionalHeader);
    s.off("audioFrame", this.onAudioFrame);
    s.off("error", this.onLiveError);
    await s.stop().catch(() => {});
    await this.startIdleLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.goIdle();
    this.stopIdleLoop();
    this.emit("close");
  }

  private async startIdleLoop(): Promise<void> {
    if (this.stopped) return;
    this.idlePlaceholder = await this.renderer.render(this.lastKeyframe);
    if (!this.idlePlaceholder || !this.lastKeyframe) {
      this.logger?.debug?.("[ContinuousVideoStream] no keyframe yet; idle loop deferred");
      return;
    }
    const stepUs = Math.round(1_000_000 / this.idleFps);
    const videoType = this.lastKeyframe.videoType;
    this.idleTimer = setInterval(() => {
      if (!this.idlePlaceholder) return;
      this.lastMicroseconds += stepUs;
      this.emit("videoAccessUnit", {
        data: this.idlePlaceholder,
        isKeyframe: true,
        videoType,
        microseconds: this.lastMicroseconds,
      });
    }, Math.round(1000 / this.idleFps));
  }

  private stopIdleLoop(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    this.idlePlaceholder = null;
  }

  private onLiveAccessUnit = (au: VideoAccessUnit) => {
    if (au.isKeyframe) {
      this.lastKeyframe = { data: au.data, videoType: au.videoType };
    }
    this.lastMicroseconds = au.microseconds;
    this.emit("videoAccessUnit", au);
  };
  private onAdditionalHeader = (h: unknown) => this.emit("additionalHeader", h);
  private onAudioFrame = (a: Buffer) => this.emit("audioFrame", a);
  private onLiveError = (e: Error) => this.emit("error", e);
}
