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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.o.api.onSimpleEvent(this.handler);
    if (this.primeOnStart) {
      await this.openWindow();
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
  }

  private async onEvent(e: ReolinkSimpleEvent): Promise<void> {
    if (e.channel !== this.o.channel) return;
    if (!this.triggers.has(e.type as AlwaysOnTrigger)) return;
    await this.openWindow();
  }

  private async openWindow(): Promise<void> {
    if (this.windowTimer) clearTimeout(this.windowTimer);
    if (!this.live) {
      this.live = true;
      try {
        await this.o.api.wakeUp(this.o.channel).catch(() => {});
        await this.o.goLive();
      } catch (err) {
        this.live = false;
        this.logger?.warn?.(
          `[AlwaysOnController] goLive failed: ${(err as Error)?.message}`,
        );
        return;
      }
    }
    this.windowTimer = setTimeout(() => void this.closeWindow(), this.windowMs);
  }

  private async closeWindow(): Promise<void> {
    this.windowTimer = null;
    if (!this.live) return;
    this.live = false;
    await this.o.goIdle().catch((err) =>
      this.logger?.warn?.(
        `[AlwaysOnController] goIdle failed: ${(err as Error)?.message}`,
      ),
    );
  }
}
