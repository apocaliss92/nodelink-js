import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { ReolinkCgiApi } from "./cgi/ReolinkCgiApi";
import type { Logger } from "../debug/DebugConfig";
import { BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID } from "../bcudp/constants";
import { decodeBcUdpPacket } from "../bcudp/packets";
import { parseD2cDisc } from "../bcudp/xml";

export interface DiscoveredDevice {
  /** Device IP address */
  host: string;
  /** Device HTTP port (default: 80) */
  httpPort?: number;
  /** Device HTTPS port (default: 443) */
  httpsPort?: number;
  /** Device model/type */
  model?: string;
  /** Device UID (if available) */
  uid?: string;
  /** Device name (if available) */
  name?: string;
  /** Firmware version (if available) */
  firmwareVersion?: string;
  /** Discovery method used to find this device */
  discoveryMethod: "http_probe" | "udp_broadcast";
  /** Whether HTTPS is supported */
  supportsHttps?: boolean;
  /** Whether the device is accessible via HTTP */
  httpAccessible?: boolean;
}

export type DiscoveryOptions = {
  /** Network CIDR to scan (e.g., "192.168.1.0/24"). If not provided, auto-detects local network */
  networkCidr?: string;
  /** Username to use for authentication attempts (default: "admin") */
  username?: string;
  /** Password to use for authentication attempts (default: empty, will try unauthenticated) */
  password?: string;
  /** Timeout per HTTP probe in milliseconds (default: 2000) */
  httpProbeTimeoutMs?: number;
  /** Timeout for UDP broadcast in milliseconds (default: 5000) */
  udpBroadcastTimeoutMs?: number;
  /** Maximum number of concurrent HTTP probes (default: 50) */
  maxConcurrentProbes?: number;
  /** Logger instance for debug output */
  logger?: Logger;
  /** Whether to enable UDP broadcast discovery (default: true) */
  enableUdpDiscovery?: boolean;
  /** Whether to enable HTTP port scanning (default: true) */
  enableHttpScanning?: boolean;
  /** Ports to scan for HTTP (default: [80, 443]) */
  httpPorts?: number[];
};

/**
 * Get local network interfaces and their CIDR ranges.
 */
function getLocalNetworks(): string[] {
  const networks: string[] = [];
  const interfaces = networkInterfaces();

  for (const ifaceName of Object.keys(interfaces)) {
    const iface = interfaces[ifaceName];
    if (!iface) continue;

    for (const addr of iface) {
      // Skip internal and non-IPv4 addresses
      if (addr.internal || addr.family !== "IPv4" || !addr.netmask) continue;

      // Calculate CIDR from IP and netmask
      const ipParts = addr.address.split(".").map(Number);
      const maskParts = addr.netmask.split(".").map(Number);

      // Count network bits
      let cidr = 0;
      for (let i = 0; i < 4; i++) {
        const maskValue = maskParts[i];
        if (maskValue === undefined || !Number.isFinite(maskValue)) break;
        if (maskValue === 255) {
          cidr += 8;
        } else if (maskValue === 0) {
          break;
        } else {
          // Count bits in partial octet
          let bits = 0;
          let m: number = maskValue;
          while (m > 0) {
            if (m & 1) bits++;
            m = m >> 1;
          }
          cidr += bits;
          break;
        }
      }

      const networkCidr = `${addr.address.split(".").slice(0, 3).join(".")}.0/${cidr}`;
      if (!networks.includes(networkCidr)) {
        networks.push(networkCidr);
      }
    }
  }

  return networks;
}

/**
 * Parse CIDR notation to get IP range.
 */
function parseCidr(cidr: string): { start: number; end: number; count: number } | null {
  const parts = cidr.split("/");
  const network = parts[0];
  const prefixStr = parts[1];
  if (!network) return null;
  const prefix = Number.parseInt(prefixStr ?? "24", 10);
  if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;

  const ipParts = network.split(".").map(Number);
  if (ipParts.length !== 4 || ipParts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;

  const networkBits = prefix;
  const hostBits = 32 - networkBits;

  // Calculate network address
  let networkAddr = 0;
  for (let i = 0; i < 4; i++) {
    const part = ipParts[i];
    if (part === undefined || !Number.isFinite(part)) return null;
    networkAddr = (networkAddr << 8) | (part & 0xff);
  }

  // Mask network bits
  const mask = ((1 << networkBits) - 1) << hostBits;
  networkAddr &= mask;

  // Calculate host range (skip network and broadcast addresses for /24)
  const hostCount = 1 << hostBits;
  const start = prefix >= 24 ? networkAddr + 1 : networkAddr;
  const end = prefix >= 24 ? networkAddr + hostCount - 2 : networkAddr + hostCount - 1;

  return {
    start,
    end,
    count: end - start + 1,
  };
}

/**
 * Convert IP number to string.
 */
function ipNumberToString(ip: number): string {
  return `${(ip >>> 24) & 0xff}.${(ip >>> 16) & 0xff}.${(ip >>> 8) & 0xff}.${ip & 0xff}`;
}

/**
 * Probe a single IP address for Reolink device via HTTP/CGI.
 */
async function probeHttpDevice(
  ip: string,
  port: number,
  options: {
    username?: string;
    password?: string;
    timeoutMs: number;
    logger?: Logger;
    useHttps?: boolean;
  },
): Promise<DiscoveredDevice | null> {
  const { username, password, timeoutMs, logger, useHttps } = options;

  try {
    // Try to connect and get device info without authentication first
    const cgi = new ReolinkCgiApi({
      host: ip,
      port,
      useHttps: useHttps ?? false,
      username: username ?? "admin",
      password: password ?? "",
      timeoutMs,
    });

    // Try to get device info (this will fail if auth is required, which is fine)
    try {
      const info = await cgi.getInfo();
      if (info?.type) {
        logger?.log?.(`[Discovery] Found Reolink device at ${ip}:${port} (${useHttps ? "HTTPS" : "HTTP"}) - ${info.type}`);
        const result: DiscoveredDevice = {
          host: ip,
          discoveryMethod: "http_probe",
          supportsHttps: useHttps ?? false,
          httpAccessible: !useHttps,
        };
        if (port !== undefined) {
          if (useHttps) {
            result.httpsPort = port;
          } else {
            result.httpPort = port;
          }
        }
        if (info.type) result.model = info.type.trim();
        if (info.name) result.name = info.name.trim();
        if (info.firmwareVersion) result.firmwareVersion = info.firmwareVersion.trim();
        return result;
      }
    } catch {
      // If unauthenticated fails, try with credentials if provided
      if (username && password) {
        try {
          await cgi.login();
          const info = await cgi.getInfo();
          if (info?.type) {
            logger?.log?.(`[Discovery] Found authenticated Reolink device at ${ip}:${port} (${useHttps ? "HTTPS" : "HTTP"}) - ${info.type}`);
            const result: DiscoveredDevice = {
              host: ip,
              discoveryMethod: "http_probe",
              supportsHttps: useHttps ?? false,
              httpAccessible: !useHttps,
            };
            if (port !== undefined) {
              if (useHttps) {
                result.httpsPort = port;
              } else {
                result.httpPort = port;
              }
            }
            if (info.type) result.model = info.type.trim();
            if (info.name) result.name = info.name.trim();
            if (info.firmwareVersion) result.firmwareVersion = info.firmwareVersion.trim();
            return result;
          }
        } catch {
          // Ignore auth failures
        }
      }
    }

    // Note: We already tried via ReolinkCgiApi above, so if we get here
    // the device is either not Reolink or not accessible
  } catch (err) {
    // Ignore connection errors
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("ECONNREFUSED") && !msg.includes("ETIMEDOUT")) {
      logger?.warn?.(`[Discovery] Error probing ${ip}:${port}: ${msg}`);
    }
  }

  return null;
}

/**
 * Discover devices via HTTP port scanning.
 */
export async function discoverViaHttpScan(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableHttpScanning) return [];

  const logger = options.logger;
  const networkCidr = options.networkCidr ?? getLocalNetworks()[0];
  const httpPorts = options.httpPorts ?? [80, 443];
  const timeoutMs = options.httpProbeTimeoutMs ?? 2000;
  const maxConcurrent = options.maxConcurrentProbes ?? 50;

  if (!networkCidr) {
    logger?.warn?.("[Discovery] No network CIDR available for HTTP scanning");
    return [];
  }

  logger?.log?.(`[Discovery] Starting HTTP scan on network ${networkCidr}...`);

  const ipRange = parseCidr(networkCidr);
  if (!ipRange) {
    logger?.warn?.(`[Discovery] Invalid CIDR: ${networkCidr}`);
    return [];
  }

  const discovered: DiscoveredDevice[] = [];
  const ipAddresses: Array<{ ip: string; port: number; useHttps: boolean }> = [];

  // Generate IP addresses to scan
  for (let ipNum = ipRange.start; ipNum <= ipRange.end && ipNum <= ipRange.start + 254; ipNum++) {
    const ip = ipNumberToString(ipNum);
    for (const port of httpPorts) {
      ipAddresses.push({ ip, port, useHttps: port === 443 });
    }
  }

  logger?.log?.(`[Discovery] Scanning ${ipAddresses.length} IP:port combinations...`);

  // Probe in batches to limit concurrency
  for (let i = 0; i < ipAddresses.length; i += maxConcurrent) {
    const batch = ipAddresses.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map(({ ip, port, useHttps }) => {
        const probeOptions: {
          username?: string;
          password?: string;
          timeoutMs: number;
          logger?: Logger;
          useHttps?: boolean;
        } = {
          timeoutMs,
          useHttps,
        };
        if (options.username !== undefined) probeOptions.username = options.username;
        if (options.password !== undefined) probeOptions.password = options.password;
        if (logger !== undefined) probeOptions.logger = logger;
        return probeHttpDevice(ip, port, probeOptions);
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        discovered.push(result.value);
      }
    }
  }

  logger?.log?.(`[Discovery] HTTP scan complete. Found ${discovered.length} device(s).`);
  return discovered;
}

/**
 * Discover devices via UDP broadcast (for battery cameras).
 */
async function discoverViaUdpBroadcast(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableUdpDiscovery) return [];

  const logger = options.logger;
  const timeoutMs = options.udpBroadcastTimeoutMs ?? 5000;
  const discovered: DiscoveredDevice[] = [];

  logger?.log?.(`[Discovery] Starting UDP broadcast discovery on ports ${BCUDP_DISCOVERY_PORT_LOCAL_ANY} and ${BCUDP_DISCOVERY_PORT_LOCAL_UID}...`);

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const devices = new Map<string, DiscoveredDevice>();
    let timeout: NodeJS.Timeout | undefined;

    socket.on("message", (msg, rinfo) => {
      try {
        const packet = decodeBcUdpPacket(msg);
        if (packet.kind === "discovery") {
          try {
            // Try to parse D2C_DISC (discovery response)
            const disc = parseD2cDisc(packet.xml);
            const host = rinfo.address;

            // D2C_DISC contains cid and did, but not UID/model/name directly
            // We need to extract additional info from the XML if available
            if (disc && !devices.has(host)) {
              // Try to extract UID, model, name from XML if present
              const uidMatch = /<uid>([^<]+)<\/uid>/i.exec(packet.xml);
              const modelMatch = /<model>([^<]+)<\/model>/i.exec(packet.xml);
              const nameMatch = /<name>([^<]+)<\/name>/i.exec(packet.xml);
              const deviceIdMatch = /<deviceId>([^<]+)<\/deviceId>/i.exec(packet.xml);

              const uid = uidMatch?.[1] ?? deviceIdMatch?.[1];
              const model = modelMatch?.[1];
              const name = nameMatch?.[1];

              logger?.log?.(`[Discovery] Found device via UDP broadcast: ${host}${uid ? ` (UID: ${uid})` : ""}`);
              const result: DiscoveredDevice = {
                host,
                discoveryMethod: "udp_broadcast",
              };
              if (model) result.model = model.trim();
              if (uid) result.uid = uid.trim();
              if (name) result.name = name.trim();
              devices.set(host, result);
            }
          } catch (err) {
            // Ignore parse errors
            logger?.debug?.(
              `[Discovery] Failed to parse UDP discovery response from ${rinfo.address}:${rinfo.port}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      } catch (err) {
        // Ignore decode errors
      }
    });

    socket.on("error", (err) => {
      logger?.warn?.(`[Discovery] UDP socket error: ${err.message}`);
    });

    socket.bind(() => {
      socket.setBroadcast(true);

      // Send discovery packets
      const discoveryPorts = [BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID];
      for (const port of discoveryPorts) {
        try {
          // Send a simple broadcast packet (empty payload should trigger discovery responses)
          socket.send(Buffer.alloc(0), port, "255.255.255.255", (err) => {
            if (err) {
              logger?.warn?.(`[Discovery] Failed to send UDP broadcast to port ${port}: ${err.message}`);
            }
          });
        } catch (err) {
          // Ignore send errors
        }
      }

      // Set timeout
      timeout = setTimeout(() => {
        socket.close();
        resolve(Array.from(devices.values()));
        logger?.log?.(`[Discovery] UDP broadcast complete. Found ${devices.size} device(s).`);
      }, timeoutMs);
    });

    // Cleanup on close
    socket.on("close", () => {
      if (timeout) clearTimeout(timeout);
    });
  });
}

/**
 * Discover Reolink devices on the local network using multiple methods.
 * This is a "best effort" discovery that tries HTTP port scanning and UDP broadcast.
 *
 * @param options - Discovery configuration options
 * @returns Array of discovered devices
 *
 * @example
 * ```typescript
 * const devices = await discoverReolinkDevices({
 *   username: "admin",
 *   password: "password",
 *   logger: console,
 * });
 *
 * for (const device of devices) {
 *   console.log(`Found: ${device.host} - ${device.model} (${device.uid})`);
 * }
 * ```
 */
export async function discoverReolinkDevices(options: DiscoveryOptions = {}): Promise<DiscoveredDevice[]> {
  const logger = options.logger;
  logger?.log?.("[Discovery] Starting Reolink device discovery...");

  const results: DiscoveredDevice[] = [];
  const seenDevices = new Map<string, DiscoveredDevice>();

  // Merge results from different discovery methods
  const mergeDevice = (device: DiscoveredDevice) => {
    const key = device.host;
    const existing = seenDevices.get(key);
    if (existing) {
      // Merge information
      if (!existing.model && device.model) existing.model = device.model;
      if (!existing.uid && device.uid) existing.uid = device.uid;
      if (!existing.name && device.name) existing.name = device.name;
      if (!existing.firmwareVersion && device.firmwareVersion) existing.firmwareVersion = device.firmwareVersion;
      if (device.httpPort && !existing.httpPort) existing.httpPort = device.httpPort;
      if (device.httpsPort && !existing.httpsPort) existing.httpsPort = device.httpsPort;
      if (device.supportsHttps !== undefined) existing.supportsHttps = device.supportsHttps;
      if (device.httpAccessible !== undefined) existing.httpAccessible = device.httpAccessible;
    } else {
      seenDevices.set(key, { ...device });
      results.push(seenDevices.get(key)!);
    }
  };

  // Run discovery methods in parallel
  const [httpDevices, udpDevices] = await Promise.all([
    discoverViaHttpScan(options),
    discoverViaUdpBroadcast(options),
  ]);

  // Merge results
  for (const device of httpDevices) {
    mergeDevice(device);
  }
  for (const device of udpDevices) {
    mergeDevice(device);
  }

  logger?.log?.(`[Discovery] Discovery complete. Found ${results.length} unique device(s).`);
  return results;
}

