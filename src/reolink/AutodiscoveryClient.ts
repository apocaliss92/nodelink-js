import {
  discoverReolinkDevices,
  type DiscoveredDevice,
  type DiscoveryOptions,
} from "./discovery";

export interface AutodiscoveryClientOptions extends DiscoveryOptions {
  /** Interval between discovery scans in milliseconds (default: 120000 = 2 minutes) */
  scanIntervalMs?: number;
  /** Whether to start discovery automatically on construction (default: false) */
  autoStart?: boolean;
  /** Called when new (previously unseen) devices are discovered */
  onDeviceDiscovered?: (device: DiscoveredDevice) => void;
  /** Called when an existing device's info is updated (e.g. model filled in) */
  onDeviceUpdated?: (device: DiscoveredDevice) => void;
}

/**
 * Continuous discovery client for Reolink cameras on the network.
 * Runs periodic scans using all configured discovery methods and maintains
 * an always-up-to-date list of discovered devices.
 *
 * Supports callbacks for new/updated devices, making it ideal for plugins
 * that want to be notified as cameras appear (e.g. battery cameras waking up).
 *
 * @example
 * ```typescript
 * const client = new AutodiscoveryClient({
 *   enableArpLookup: true,
 *   enableOnvifDiscovery: true,
 *   scanIntervalMs: 60_000,
 *   autoStart: true,
 *   onDeviceDiscovered: (device) => {
 *     console.log(`New device: ${device.host} (${device.model})`);
 *   },
 * });
 *
 * // Get the current list
 * const devices = client.getDiscoveredDevices();
 *
 * // Stop
 * client.stop();
 * ```
 */
export class AutodiscoveryClient {
  private readonly options: AutodiscoveryClientOptions & {
    scanIntervalMs: number;
  };
  private readonly discoveredDevices = new Map<string, DiscoveredDevice>();
  private scanTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private currentScanPromise: Promise<void> | null = null;

  constructor(options: AutodiscoveryClientOptions = {}) {
    this.options = {
      ...options,
      scanIntervalMs: options.scanIntervalMs ?? 120_000,
      autoStart: options.autoStart ?? false,
    };

    if (this.options.autoStart) {
      this.start();
    }
  }

  /**
   * Start continuous discovery. If already running, does nothing.
   */
  start(): void {
    if (this.isRunning) {
      this.options.logger?.warn?.("[Autodiscovery] Discovery already running");
      return;
    }

    this.isRunning = true;
    this.options.logger?.log?.(
      `[Autodiscovery] Starting continuous discovery (interval: ${this.options.scanIntervalMs}ms)`,
    );

    // Run first scan immediately
    this.performScan();

    // Schedule subsequent scans
    this.scheduleNextScan();
  }

  /**
   * Stop continuous discovery. If not running, does nothing.
   */
  stop(): void {
    if (!this.isRunning) {
      this.options.logger?.warn?.("[Autodiscovery] Discovery not running");
      return;
    }

    this.isRunning = false;
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }

    this.options.logger?.log?.("[Autodiscovery] Discovery stopped");
  }

  /**
   * Returns the current list of discovered devices, sorted by host IP.
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values()).sort((a, b) =>
      a.host.localeCompare(b.host),
    );
  }

  /**
   * Returns the number of currently discovered devices.
   */
  getDeviceCount(): number {
    return this.discoveredDevices.size;
  }

  /**
   * Returns whether continuous discovery is currently running.
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Force an immediate scan (doesn't wait for the scheduled interval).
   * If a scan is already in progress, waits for it to complete.
   */
  async scanNow(): Promise<void> {
    if (this.currentScanPromise) {
      this.options.logger?.log?.(
        "[Autodiscovery] Scan already in progress, waiting for completion...",
      );
      await this.currentScanPromise;
      return;
    }

    await this.performScan();
  }

  /**
   * Remove a device from the discovered list.
   */
  removeDevice(host: string): boolean {
    const removed = this.discoveredDevices.delete(host);
    if (removed) {
      this.options.logger?.log?.(`[Autodiscovery] Device removed: ${host}`);
    }
    return removed;
  }

  /**
   * Clear all discovered devices.
   */
  clearDevices(): void {
    const count = this.discoveredDevices.size;
    this.discoveredDevices.clear();
    this.options.logger?.log?.(
      `[Autodiscovery] Removed ${count} device(s) from list`,
    );
  }

  private async performScan(): Promise<void> {
    const scanPromise = (async () => {
      try {
        this.options.logger?.log?.("[Autodiscovery] Starting scan...");

        const discovered = await discoverReolinkDevices(this.options);

        const newDevices: DiscoveredDevice[] = [];
        const updatedDevices: DiscoveredDevice[] = [];

        for (const device of discovered) {
          const existing = this.discoveredDevices.get(device.host);
          if (existing) {
            const updated = this.mergeDeviceInfo(existing, device);
            if (updated) {
              updatedDevices.push(updated);
            }
          } else {
            this.discoveredDevices.set(device.host, { ...device });
            newDevices.push(device);
          }
        }

        this.options.logger?.log?.(
          `[Autodiscovery] Scan completed: ${newDevices.length} new, ${updatedDevices.length} updated, total: ${this.discoveredDevices.size}`,
        );

        // Fire callbacks
        for (const device of newDevices) {
          this.options.logger?.log?.(
            `[Autodiscovery] NEW DEVICE - ${device.host} | ${device.model ?? "unknown"} | ${device.name ?? ""} | via ${device.discoveryMethod}`,
          );
          try {
            this.options.onDeviceDiscovered?.(device);
          } catch {
            // ignore callback errors
          }
        }
        for (const device of updatedDevices) {
          try {
            this.options.onDeviceUpdated?.(device);
          } catch {
            // ignore callback errors
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.options.logger?.error?.(
          `[Autodiscovery] Error during scan: ${msg}`,
        );
      }
    })();

    this.currentScanPromise = scanPromise;
    await scanPromise;
    this.currentScanPromise = null;
  }

  private mergeDeviceInfo(
    existing: DiscoveredDevice,
    updated: DiscoveredDevice,
  ): DiscoveredDevice | null {
    let hasChanges = false;

    if (!existing.model && updated.model) {
      existing.model = updated.model;
      hasChanges = true;
    }
    if (!existing.uid && updated.uid) {
      existing.uid = updated.uid;
      hasChanges = true;
    }
    if (!existing.name && updated.name) {
      existing.name = updated.name;
      hasChanges = true;
    }
    if (!existing.firmwareVersion && updated.firmwareVersion) {
      existing.firmwareVersion = updated.firmwareVersion;
      hasChanges = true;
    }
    if (updated.httpPort && !existing.httpPort) {
      existing.httpPort = updated.httpPort;
      hasChanges = true;
    }
    if (updated.httpsPort && !existing.httpsPort) {
      existing.httpsPort = updated.httpsPort;
      hasChanges = true;
    }
    if (
      updated.supportsHttps !== undefined &&
      existing.supportsHttps !== updated.supportsHttps
    ) {
      existing.supportsHttps = updated.supportsHttps;
      hasChanges = true;
    }
    if (
      updated.httpAccessible !== undefined &&
      existing.httpAccessible !== updated.httpAccessible
    ) {
      existing.httpAccessible = updated.httpAccessible;
      hasChanges = true;
    }

    return hasChanges ? existing : null;
  }

  private scheduleNextScan(): void {
    if (!this.isRunning) return;

    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.isRunning) {
        this.performScan().finally(() => {
          if (this.isRunning) {
            this.scheduleNextScan();
          }
        });
      }
    }, this.options.scanIntervalMs);
  }
}
