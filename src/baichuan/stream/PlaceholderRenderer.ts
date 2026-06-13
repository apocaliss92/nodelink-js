// src/baichuan/stream/PlaceholderRenderer.ts
import type { PlaceholderOptions } from "./alwaysOnTypes";
import { ALWAYS_ON_DEFAULTS } from "./alwaysOnTypes";

export interface CachedKeyframe {
  data: Buffer;
  videoType: "H264" | "H265";
}

export interface Logger {
  info?: (...a: unknown[]) => void;
  warn?: (...a: unknown[]) => void;
  error?: (...a: unknown[]) => void;
  debug?: (...a: unknown[]) => void;
}

export class PlaceholderRenderer {
  private readonly opts: Required<PlaceholderOptions>;
  private readonly logger?: Logger;

  constructor(args: { placeholder?: PlaceholderOptions; logger?: Logger }) {
    this.opts = { ...ALWAYS_ON_DEFAULTS.placeholder, ...(args.placeholder ?? {}) };
    this.logger = args.logger;
  }

  /** Returns the access unit bytes to emit as placeholder, or null if none available. */
  async render(keyframe: CachedKeyframe | null): Promise<Buffer | null> {
    if (!keyframe) return null;
    if (!this.opts.enabled) return keyframe.data;
    // Decorated path added in a later task.
    return keyframe.data;
  }
}
