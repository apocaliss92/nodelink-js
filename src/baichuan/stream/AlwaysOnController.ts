import type { ReolinkBaichuanApi } from "../../reolink/baichuan/ReolinkBaichuanApi";
import type { ReolinkSimpleEvent } from "../../reolink/baichuan/types";
import type { AlwaysOnOptions, AlwaysOnTrigger } from "./alwaysOnTypes";
import { ALWAYS_ON_DEFAULTS } from "./alwaysOnTypes";
import type { Logger } from "./PlaceholderRenderer";

export interface AlwaysOnControllerOptions {
  api: ReolinkBaichuanApi;
  channel: number;
  options: AlwaysOnOptions;
  goLive: () => Promise<void>;
  goIdle: () => Promise<void>;
  logger?: Logger;
}

export class AlwaysOnController {
  private readonly triggers: Set<AlwaysOnTrigger>;
  private readonly windowMs: number;
  private readonly primeOnStart: boolean;
  private readonly logger: Logger | undefined;
  private windowTimer: ReturnType<typeof setTimeout> | null = null;
  private live = false;
  private started = false;
  private readonly handler = (e: ReolinkSimpleEvent) => void this.onEvent(e);

  constructor(private readonly o: AlwaysOnControllerOptions) {
    this.triggers = new Set(o.options.triggers ?? ALWAYS_ON_DEFAULTS.triggers);
    this.windowMs = o.options.windowMs ?? ALWAYS_ON_DEFAULTS.windowMs;
    this.primeOnStart = o.options.primeOnStart ?? ALWAYS_ON_DEFAULTS.primeOnStart;
    this.logger = o.logger;
  }

  private get windowSeconds(): number {
    return Math.round(this.windowMs / 1000);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.o.api.onSimpleEvent(this.handler);
    this.logger?.info?.(
      `[AlwaysOnController] started ch${this.o.channel} — triggers=[${[...this.triggers].join(", ")}], window=${this.windowSeconds}s, primeOnStart=${this.primeOnStart}`,
    );
    if (this.primeOnStart) {
      await this.openWindow("prime");
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    if (this.windowTimer) {
      clearTimeout(this.windowTimer);
      this.windowTimer = null;
    }
    await this.o.api.offSimpleEvent(this.handler).catch(() => {});
    if (this.live) {
      this.live = false;
      await this.o.goIdle().catch(() => {});
    }
    this.logger?.info?.(`[AlwaysOnController] stopped ch${this.o.channel}`);
  }

  private async onEvent(e: ReolinkSimpleEvent): Promise<void> {
    if (e.channel !== this.o.channel) return;
    if (!this.triggers.has(e.type as AlwaysOnTrigger)) {
      this.logger?.debug?.(
        `[AlwaysOnController] event '${e.type}' ch${e.channel} ignored (not a configured trigger)`,
      );
      return;
    }
    await this.openWindow(e.type);
  }

  private async openWindow(reason: string): Promise<void> {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    if (!this.live) {
      this.live = true;
      try {
        await this.o.api.wakeUp(this.o.channel).catch(() => {});
        await this.o.goLive();
        this.logger?.info?.(
          `[AlwaysOnController] live window OPENED (trigger=${reason}) — streaming real frames; will sleep in ${this.windowSeconds}s without new events`,
        );
      } catch (err) {
        this.live = false;
        this.logger?.warn?.(
          `[AlwaysOnController] goLive failed: ${(err as Error)?.message}`,
        );
        return;
      }
    } else {
      this.logger?.info?.(
        `[AlwaysOnController] live window EXTENDED (trigger=${reason}) — sleep timer reset to ${this.windowSeconds}s`,
      );
    }
    this.windowTimer = setTimeout(() => void this.closeWindow(), this.windowMs);
  }

  private async closeWindow(): Promise<void> {
    this.windowTimer = null;
    if (!this.live) return;
    this.live = false;
    this.logger?.info?.(
      `[AlwaysOnController] live window CLOSED — going idle (placeholder); camera can sleep`,
    );
    await this.o.goIdle().catch((err) =>
      this.logger?.warn?.(
        `[AlwaysOnController] goIdle failed: ${(err as Error)?.message}`,
      ),
    );
  }
}
