import type { Logger } from "../debug/DebugConfig";
import { discoverReolinkDevices, discoverViaHttpScan, discoverViaUdpBroadcast, type DiscoveredDevice, type DiscoveryOptions } from "./discovery";

export interface AutodiscoveryClientOptions {
  /** Network CIDR to scan (e.g., "192.168.1.0/24"). If not provided, auto-detects local network */
  networkCidr?: string;
  /** Username to use for authentication attempts (default: "admin") */
  username?: string;
  /** Password to use for authentication attempts (default: empty, will try unauthenticated) */
  password?: string;
  /** Timeout per HTTP probe in milliseconds (default: 2000) */
  httpProbeTimeoutMs?: number;
  /** Maximum number of concurrent HTTP probes (default: 50) */
  maxConcurrentProbes?: number;
  /** Logger instance for debug output */
  logger?: Logger;
  /** Ports to scan for HTTP (default: [80, 443]) */
  httpPorts?: number[];
  /** Interval between discovery scans in milliseconds (default: 60000 = 60 seconds) */
  scanIntervalMs?: number;
  /** Whether to start discovery automatically on construction (default: false) */
  autoStart?: boolean;
  /** Discovery method to use: "http" (TCP/IPC), "udp" (broadcast), or "both" (default: "http") */
  discoveryMethod?: "http" | "udp" | "both";
  /** Timeout for UDP broadcast in milliseconds (default: 5000) */
  udpBroadcastTimeoutMs?: number;
}

/**
 * Client per discovery continuato di telecamere Reolink sulla rete.
 * Supporta TCP/IPC (HTTP/HTTPS scanning) e/o UDP broadcast discovery.
 * 
 * Mantiene una lista aggiornata delle telecamere discoverate e offre
 * metodi per ottenere la lista corrente e controllare il processo di discovery.
 * 
 * @example
 * ```typescript
 * const client = new AutodiscoveryClient({
 *   username: "admin",
 *   password: "password",
 *   scanIntervalMs: 30000, // 30 secondi
 *   autoStart: true,
 * });
 * 
 * // Ottieni la lista corrente
 * const devices = client.getDiscoveredDevices();
 * console.log(`Trovate ${devices.length} telecamere`);
 * 
 * // Ferma il discovery
 * await client.stop();
 * ```
 */
export class AutodiscoveryClient {
  private readonly options: AutodiscoveryClientOptions & { scanIntervalMs: number };
  private readonly discoveredDevices = new Map<string, DiscoveredDevice>();
  private scanTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private currentScanPromise: Promise<void> | null = null;

  /**
   * Costruttore del client di autodiscovery.
   * 
   * @param options - Opzioni di configurazione per il discovery
   */
  constructor(options: AutodiscoveryClientOptions = {}) {
    this.options = {
      scanIntervalMs: options.scanIntervalMs ?? 60_000, // Default: 60 secondi
      autoStart: options.autoStart ?? false,
    };
    if (options.networkCidr !== undefined) {
      this.options.networkCidr = options.networkCidr;
    }
    if (options.username !== undefined) {
      this.options.username = options.username;
    }
    if (options.password !== undefined) {
      this.options.password = options.password;
    }
    if (options.httpProbeTimeoutMs !== undefined) {
      this.options.httpProbeTimeoutMs = options.httpProbeTimeoutMs;
    }
    if (options.maxConcurrentProbes !== undefined) {
      this.options.maxConcurrentProbes = options.maxConcurrentProbes;
    }
    if (options.logger !== undefined) {
      this.options.logger = options.logger;
    }
    if (options.httpPorts !== undefined) {
      this.options.httpPorts = options.httpPorts;
    }
    if (options.discoveryMethod !== undefined) {
      this.options.discoveryMethod = options.discoveryMethod;
    }
    if (options.udpBroadcastTimeoutMs !== undefined) {
      this.options.udpBroadcastTimeoutMs = options.udpBroadcastTimeoutMs;
    }

    if (this.options.autoStart) {
      this.start();
    }
  }

  /**
   * Avvia il discovery continuato.
   * Se già in esecuzione, non fa nulla.
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

    // Esegui il primo scan immediatamente
    this.performScan();

    // Poi programma gli scan successivi
    this.scheduleNextScan();
  }

  /**
   * Ferma il discovery continuato.
   * Se non è in esecuzione, non fa nulla.
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
   * Restituisce la lista corrente delle telecamere discoverate.
   * 
   * @returns Array di dispositivi discoverati, ordinati per host
   */
  getDiscoveredDevices(): DiscoveredDevice[] {
    return Array.from(this.discoveredDevices.values()).sort((a, b) => {
      // Ordina per host (IP address)
      return a.host.localeCompare(b.host);
    });
  }

  /**
   * Restituisce il numero di telecamere attualmente discoverate.
   * 
   * @returns Numero di dispositivi discoverati
   */
  getDeviceCount(): number {
    return this.discoveredDevices.size;
  }

  /**
   * Verifica se il discovery è attualmente in esecuzione.
   * 
   * @returns `true` se il discovery è in esecuzione, `false` altrimenti
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Forza un scan immediato (non aspetta l'intervallo programmato).
   * Se uno scan è già in corso, attende il completamento prima di avviarne uno nuovo.
   * 
   * @returns Promise che si risolve quando lo scan è completato
   */
  async scanNow(): Promise<void> {
    if (this.currentScanPromise) {
      this.options.logger?.log?.("[Autodiscovery] Scan already in progress, waiting for completion...");
      await this.currentScanPromise;
      return;
    }

    await this.performScan();
  }

  /**
   * Rimuove un dispositivo dalla lista (utile se si sa che non è più disponibile).
   * 
   * @param host - Indirizzo IP del dispositivo da rimuovere
   * @returns `true` se il dispositivo è stato rimosso, `false` se non era presente
   */
  removeDevice(host: string): boolean {
    const removed = this.discoveredDevices.delete(host);
    if (removed) {
      this.options.logger?.log?.(`[Autodiscovery] Device removed: ${host}`);
    }
    return removed;
  }

  /**
   * Pulisce tutte le telecamere discoverate dalla lista.
   */
  clearDevices(): void {
    const count = this.discoveredDevices.size;
    this.discoveredDevices.clear();
    this.options.logger?.log?.(`[Autodiscovery] Removed ${count} device(s) from list`);
  }

  /**
   * Esegue un singolo scan della rete.
   */
  private async performScan(): Promise<void> {
    const scanPromise = (async () => {
      try {
        this.options.logger?.log?.("[Autodiscovery] Starting scan...");

        const discoveryMethod = this.options.discoveryMethod ?? "http";
        const discoveryOptions: DiscoveryOptions = {
          enableHttpScanning: discoveryMethod === "http" || discoveryMethod === "both",
          enableUdpDiscovery: discoveryMethod === "udp" || discoveryMethod === "both",
        };
        if (this.options.networkCidr !== undefined) {
          discoveryOptions.networkCidr = this.options.networkCidr;
        }
        if (this.options.username !== undefined) {
          discoveryOptions.username = this.options.username;
        }
        if (this.options.password !== undefined) {
          discoveryOptions.password = this.options.password;
        }
        if (this.options.httpProbeTimeoutMs !== undefined) {
          discoveryOptions.httpProbeTimeoutMs = this.options.httpProbeTimeoutMs;
        }
        if (this.options.maxConcurrentProbes !== undefined) {
          discoveryOptions.maxConcurrentProbes = this.options.maxConcurrentProbes;
        }
        if (this.options.logger !== undefined) {
          discoveryOptions.logger = this.options.logger;
        }
        if (this.options.httpPorts !== undefined) {
          discoveryOptions.httpPorts = this.options.httpPorts;
        }
        if (this.options.udpBroadcastTimeoutMs !== undefined) {
          discoveryOptions.udpBroadcastTimeoutMs = this.options.udpBroadcastTimeoutMs;
        }

        // Use the appropriate discovery method(s)
        let discovered: DiscoveredDevice[] = [];
        if (discoveryMethod === "http" || discoveryMethod === "both") {
          const httpDevices = await discoverViaHttpScan(discoveryOptions);
          discovered.push(...httpDevices);
        }
        if (discoveryMethod === "udp" || discoveryMethod === "both") {
          const udpDevices = await discoverViaUdpBroadcast(discoveryOptions);
          discovered.push(...udpDevices);
        }

        // Aggiorna la mappa dei dispositivi
        const beforeCount = this.discoveredDevices.size;
        const newDevices: DiscoveredDevice[] = [];
        const updatedDevices: DiscoveredDevice[] = [];

        for (const device of discovered) {
          const existing = this.discoveredDevices.get(device.host);
          if (existing) {
            // Aggiorna il dispositivo esistente con nuove informazioni
            const updated = this.mergeDeviceInfo(existing, device);
            if (updated) {
              updatedDevices.push(updated);
            }
          } else {
            // Nuovo dispositivo
            this.discoveredDevices.set(device.host, { ...device });
            newDevices.push(device);
          }
        }

        const afterCount = this.discoveredDevices.size;
        this.options.logger?.log?.(
          `[Autodiscovery] Scan completed: ${newDevices.length} new, ${updatedDevices.length} updated, total: ${afterCount}`,
        );

        // Log each new device immediately with full details
        for (const device of newDevices) {
          const details: string[] = [];
          if (device.model) details.push(`Model: ${device.model}`);
          if (device.name) details.push(`Name: ${device.name}`);
          if (device.uid) details.push(`UID: ${device.uid}`);
          if (device.firmwareVersion) details.push(`Firmware: ${device.firmwareVersion}`);
          if (device.httpPort) details.push(`HTTP Port: ${device.httpPort}`);
          if (device.httpsPort) details.push(`HTTPS Port: ${device.httpsPort}`);
          details.push(`Discovery Method: ${device.discoveryMethod}`);
          if (device.supportsHttps !== undefined) details.push(`HTTPS: ${device.supportsHttps}`);
          if (device.httpAccessible !== undefined) details.push(`HTTP Accessible: ${device.httpAccessible}`);

          this.options.logger?.log?.(
            `[Autodiscovery] 🆕 NEW DEVICE DISCOVERED - Host: ${device.host}${details.length > 0 ? ` | ${details.join(" | ")}` : ""}`,
          );
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.options.logger?.error?.(`[Autodiscovery] Error during scan: ${msg}`);
      }
    })();

    this.currentScanPromise = scanPromise;
    await scanPromise;
    this.currentScanPromise = null;
  }

  /**
   * Unisce le informazioni di un dispositivo esistente con quelle di un nuovo scan.
   * Restituisce il dispositivo aggiornato se ci sono state modifiche, altrimenti `null`.
   */
  private mergeDeviceInfo(existing: DiscoveredDevice, updated: DiscoveredDevice): DiscoveredDevice | null {
    let hasChanges = false;

    // Aggiorna i campi mancanti o più recenti
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
    if (updated.supportsHttps !== undefined && existing.supportsHttps !== updated.supportsHttps) {
      existing.supportsHttps = updated.supportsHttps;
      hasChanges = true;
    }
    if (updated.httpAccessible !== undefined && existing.httpAccessible !== updated.httpAccessible) {
      existing.httpAccessible = updated.httpAccessible;
      hasChanges = true;
    }

    return hasChanges ? existing : null;
  }

  /**
   * Programma il prossimo scan.
   */
  private scheduleNextScan(): void {
    if (!this.isRunning) {
      return;
    }

    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      if (this.isRunning) {
        this.performScan().finally(() => {
          // Programma il prossimo scan solo se siamo ancora in esecuzione
          if (this.isRunning) {
            this.scheduleNextScan();
          }
        });
      }
    }, this.options.scanIntervalMs);
  }
}

