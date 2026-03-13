import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import * as net from "node:net";
import { networkInterfaces, platform } from "node:os";
import { promisify } from "node:util";
import { ReolinkCgiApi } from "./cgi/ReolinkCgiApi";
import type { Logger } from "../debug/DebugConfig";

const execFileAsync = promisify(execFile);
import { BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID } from "../bcudp/constants";
import { decodeBcUdpPacket, encodeDiscoveryPacket } from "../bcudp/packets";
import { buildC2dS, parseD2cCr, parseD2cDisc } from "../bcudp/xml";

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
  discoveryMethod: "http_probe" | "udp_broadcast" | "udp_direct" | "tcp_port_scan" | "arp" | "dhcp" | "onvif";
  /** Whether HTTPS is supported */
  supportsHttps?: boolean;
  /** Whether the device is accessible via HTTP */
  httpAccessible?: boolean;
}

/**
 * Discover a single device via UDP unicast (useful when broadcast is blocked).
 * This does NOT establish a BCUDP session; it only extracts UID/model/name if present.
 */
export async function discoverViaUdpDirect(host: string, options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableUdpDiscovery) return [];

  const logger = options.logger;
  const timeoutMs = options.udpBroadcastTimeoutMs ?? 1500;
  const discovered: DiscoveredDevice[] = [];

  const targetHost = host?.trim();
  if (!targetHost) return [];

  logger?.log?.(`[Discovery] Starting UDP direct discovery to ${targetHost} on ports ${BCUDP_DISCOVERY_PORT_LOCAL_ANY} and ${BCUDP_DISCOVERY_PORT_LOCAL_UID}...`);

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let timeout: NodeJS.Timeout | undefined;

    socket.on("message", (msg, rinfo) => {
      try {
        if (rinfo.address !== targetHost) return;
        const packet = decodeBcUdpPacket(msg);
        if (packet.kind !== "discovery") return;

        const cr = parseD2cCr(packet.xml);
        const disc = cr ? undefined : parseD2cDisc(packet.xml);
        if (!cr && !disc) return;

        const uidMatch = /<uid>([^<]+)<\/uid>/i.exec(packet.xml);
        const modelMatch = /<model>([^<]+)<\/model>/i.exec(packet.xml);
        const nameMatch = /<name>([^<]+)<\/name>/i.exec(packet.xml);
        const deviceIdMatch = /<deviceId>([^<]+)<\/deviceId>/i.exec(packet.xml);

        const uid = (uidMatch?.[1] ?? deviceIdMatch?.[1])?.trim();
        const model = modelMatch?.[1]?.trim();
        const name = nameMatch?.[1]?.trim();

        const result: DiscoveredDevice = {
          host: rinfo.address,
          discoveryMethod: "udp_direct",
          ...(uid ? { uid } : {}),
          ...(model ? { model } : {}),
          ...(name ? { name } : {}),
        };

        discovered.push(result);

        // We got what we need; close early.
        try {
          socket.close();
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    });

    socket.on("error", (err) => {
      logger?.warn?.(`[Discovery] UDP direct socket error: ${err.message}`);
    });

    socket.bind(() => {
      const localPort = socket.address().port;
      const discoveryPorts = [BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID];

      for (const port of discoveryPorts) {
        try {
          const tid = Math.floor(Math.random() * 0xff) || 1;
          const xml = buildC2dS({ clientPort: localPort });
          const packet = encodeDiscoveryPacket(tid, xml);
          socket.send(packet, port, targetHost, (err) => {
            if (err) {
              logger?.debug?.(`[Discovery] Failed to send UDP direct to ${targetHost}:${port}: ${err.message}`);
            }
          });
        } catch {
          // ignore
        }
      }

      timeout = setTimeout(() => {
        try {
          socket.close();
        } catch {
          // ignore
        }
      }, timeoutMs);
    });

    socket.on("close", () => {
      if (timeout) clearTimeout(timeout);
      if (discovered.length === 0) {
        logger?.log?.(`[Discovery] UDP direct complete. No response from ${targetHost}.`);
      } else {
        logger?.log?.(`[Discovery] UDP direct complete. Found ${discovered.length} device(s).`);
      }
      resolve(discovered);
    });
  });
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
  /** Whether to enable TCP port 9000 scanning (Baichuan protocol). Works with all Reolink devices. (default: false) */
  enableTcpPortScan?: boolean;
  /** Timeout per TCP port probe in milliseconds (default: 1500) */
  tcpProbeTimeoutMs?: number;
  /** Whether to enable ARP table lookup for Reolink MAC prefix (ec:71:db). Similar to Home Assistant DHCP discovery. (default: false) */
  enableArpLookup?: boolean;
  /** Whether to enable passive DHCP listening for Reolink devices (requires root/NET_RAW). (default: false) */
  enableDhcpListener?: boolean;
  /** Timeout for DHCP listener in milliseconds (default: 10000) */
  dhcpListenerTimeoutMs?: number;
  /** Whether to enable ONVIF WS-Discovery (multicast probe on 239.255.255.250:3702). Most Reolink cameras support ONVIF. (default: false) */
  enableOnvifDiscovery?: boolean;
  /** Timeout for ONVIF WS-Discovery in milliseconds (default: 5000) */
  onvifDiscoveryTimeoutMs?: number;
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
export async function discoverViaUdpBroadcast(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
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
            const host = rinfo.address;
            
            // Try to parse D2C_CR (discovery response to C2D_S/C2D_C)
            const cr = parseD2cCr(packet.xml);
            if (cr && !devices.has(host)) {
              logger?.log?.(`[Discovery] Found device via UDP broadcast: ${host} (cid=${cr.cid}, did=${cr.did})`);
              const result: DiscoveredDevice = {
                host,
                discoveryMethod: "udp_broadcast",
              };
              
              // Try to extract UID, model, name from XML if present
              const uidMatch = /<uid>([^<]+)<\/uid>/i.exec(packet.xml);
              const modelMatch = /<model>([^<]+)<\/model>/i.exec(packet.xml);
              const nameMatch = /<name>([^<]+)<\/name>/i.exec(packet.xml);
              const deviceIdMatch = /<deviceId>([^<]+)<\/deviceId>/i.exec(packet.xml);

              const uid = uidMatch?.[1] ?? deviceIdMatch?.[1];
              const model = modelMatch?.[1];
              const name = nameMatch?.[1];

              if (model) result.model = model.trim();
              if (uid) result.uid = uid.trim();
              if (name) result.name = name.trim();
              
              devices.set(host, result);
              return;
            }
            
            // Fallback: try to parse D2C_DISC (disconnect message, but might contain info)
            const disc = parseD2cDisc(packet.xml);
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
      const localPort = socket.address().port;

      // Send discovery packets using proper C2D_S messages
      // Port 2015: general discovery (C2D_S without UID)
      // Port 2018: UID-specific discovery (would use C2D_C, but we don't have UIDs here)
      const discoveryPorts = [BCUDP_DISCOVERY_PORT_LOCAL_ANY, BCUDP_DISCOVERY_PORT_LOCAL_UID];
      
      for (const port of discoveryPorts) {
        try {
          // Build C2D_S message for general discovery
          const tid = Math.floor(Math.random() * 0xff) || 1;
          const xml = buildC2dS({ clientPort: localPort });
          const packet = encodeDiscoveryPacket(tid, xml);
          
          // Send to broadcast address
          socket.send(packet, port, "255.255.255.255", (err) => {
            if (err) {
              logger?.warn?.(`[Discovery] Failed to send UDP broadcast to port ${port}: ${err.message}`);
            }
          });
        } catch (err) {
          logger?.warn?.(`[Discovery] Error encoding discovery packet for port ${port}: ${err instanceof Error ? err.message : String(err)}`);
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

/** Reolink OUI MAC prefixes (uppercase, colon-separated) */
const REOLINK_MAC_PREFIXES = [
  "EC:71:DB", // Most common Reolink OUI
  "2C:1B:3A", // WiFi cameras (E1 Zoom, etc.)
  "18:2C:65", // Battery cameras (Video Doorbell, Argus, etc.)
  "DC:E5:37", // Some newer models
  "9C:8E:CD", // Some WiFi models
  "B4:4B:D6", // Some models
  "E4:3D:1A", // Some models
];

/**
 * Discover Reolink devices by reading the system ARP table and filtering
 * for Reolink MAC address prefixes (EC:71:DB). This mirrors the DHCP-based
 * discovery used by Home Assistant but reads the already-populated ARP cache
 * instead of sniffing live DHCP packets.
 *
 * Works on Linux, macOS, and Docker containers (reads /proc/net/arp or `arp -a`).
 */
export async function discoverViaArpTable(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableArpLookup) return [];

  const logger = options.logger;
  logger?.log?.("[Discovery] Starting ARP table lookup for Reolink MAC prefix...");

  const discovered: DiscoveredDevice[] = [];

  try {
    let entries: Array<{ ip: string; mac: string }> = [];

    if (platform() === "linux") {
      // Linux: read /proc/net/arp directly (works in Docker too)
      try {
        const { readFile } = await import("node:fs/promises");
        const content = await readFile("/proc/net/arp", "utf8");
        // Format: IP address HW type Flags HW address Mask Device
        for (const line of content.split("\n").slice(1)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 4 && parts[0] && parts[3] && parts[3] !== "00:00:00:00:00:00") {
            entries.push({ ip: parts[0], mac: parts[3].toUpperCase() });
          }
        }
      } catch {
        // Fallback to arp command (try common paths)
        const { stdout } = await runArpCommand();
        entries = parseArpOutput(stdout);
      }
    } else {
      // macOS / other: use arp -a
      const { stdout } = await runArpCommand();
      entries = parseArpOutput(stdout);
    }

    logger?.log?.(`[Discovery] ARP table has ${entries.length} entries`);

    for (const { ip, mac } of entries) {
      const isReolink = REOLINK_MAC_PREFIXES.some((prefix) =>
        mac.startsWith(prefix),
      );
      if (isReolink) {
        logger?.log?.(`[Discovery] Found Reolink device via ARP: ${ip} (MAC: ${mac})`);
        discovered.push({
          host: ip,
          discoveryMethod: "arp" as any,
        });
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger?.warn?.(`[Discovery] ARP table lookup failed: ${msg}`);
  }

  logger?.log?.(`[Discovery] ARP lookup complete. Found ${discovered.length} device(s).`);
  return discovered;
}

/**
 * Run the `arp -a` command, trying common binary paths.
 * On macOS arp lives in /usr/sbin which may not be in Node's PATH.
 */
async function runArpCommand(): Promise<{ stdout: string }> {
  // Use -an (no DNS resolution) — arp -a can take 10+ seconds doing reverse lookups
  const paths = ["/usr/sbin/arp", "/sbin/arp", "/usr/bin/arp", "arp"];
  for (const arpPath of paths) {
    try {
      return await execFileAsync(arpPath, ["-an"], { timeout: 5000 });
    } catch {
      // try next
    }
  }
  throw new Error("arp command not found");
}

/**
 * Parse `arp -a` output (macOS/Linux format).
 * macOS: "? (192.168.1.161) at ec:71:db:72:bb:fe on en0 ifscope [ethernet]"
 * Linux: "? (192.168.1.161) at ec:71:db:72:bb:fe [ether] on eth0"
 */
function parseArpOutput(stdout: string): Array<{ ip: string; mac: string }> {
  const results: Array<{ ip: string; mac: string }> = [];
  for (const line of stdout.split("\n")) {
    const match = /\((\d+\.\d+\.\d+\.\d+)\)\s+at\s+([0-9a-fA-F:]+)/i.exec(line);
    if (match && match[1] && match[2] && match[2] !== "(incomplete)") {
      results.push({ ip: match[1], mac: match[2].toUpperCase() });
    }
  }
  return results;
}

/**
 * Discover Reolink devices by passively listening for DHCP traffic (port 67/68).
 * Parses DHCP ACK/REQUEST packets and filters for Reolink MAC prefix or hostname.
 * Requires root or CAP_NET_RAW (typical in Docker with --net=host).
 *
 * This mirrors Home Assistant's DHCP discovery: matches hostname "reolink*" or MAC "EC:71:DB".
 */
export async function discoverViaDhcpListener(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableDhcpListener) return [];

  const logger = options.logger;
  const timeoutMs = options.dhcpListenerTimeoutMs ?? 10000;
  logger?.log?.(`[Discovery] Starting passive DHCP listener (${timeoutMs}ms)...`);

  const discovered = new Map<string, DiscoveredDevice>();

  return new Promise((resolve) => {
    let socket: dgram.Socket;
    let timeout: NodeJS.Timeout;

    try {
      socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    } catch (err) {
      logger?.warn?.(`[Discovery] DHCP: failed to create socket: ${err instanceof Error ? err.message : String(err)}`);
      resolve([]);
      return;
    }

    socket.on("message", (msg) => {
      try {
        // Minimal DHCP packet parsing (RFC 2131)
        // Byte 0: op (1=request, 2=reply)
        // Bytes 28-31: chaddr (first 6 bytes = MAC)
        // Bytes 16-19: yiaddr (your IP, set by server in ACK)
        // Bytes 12-15: ciaddr (client IP, set in REQUEST/RENEW)
        if (msg.length < 240) return;

        const op = msg[0]; // 1=BOOTREQUEST, 2=BOOTREPLY
        const hlen = msg[2]; // hardware address length (6 for ethernet)
        if (hlen !== 6) return;

        // Extract MAC address (bytes 28-33)
        const mac = [
          msg[28]?.toString(16).padStart(2, "0"),
          msg[29]?.toString(16).padStart(2, "0"),
          msg[30]?.toString(16).padStart(2, "0"),
          msg[31]?.toString(16).padStart(2, "0"),
          msg[32]?.toString(16).padStart(2, "0"),
          msg[33]?.toString(16).padStart(2, "0"),
        ].join(":").toUpperCase();

        // Check if MAC matches Reolink prefix
        const isReolinkMac = REOLINK_MAC_PREFIXES.some((p) => mac.startsWith(p));

        // Extract hostname from DHCP options (option 12)
        let hostname = "";
        let i = 240; // DHCP options start after magic cookie at byte 236 + 4
        while (i < msg.length - 1) {
          const optType = msg[i];
          if (optType === 255) break; // End
          if (optType === 0) { i++; continue; } // Padding
          const optLen = msg[i + 1] ?? 0;
          if (optType === 12 && optLen > 0) {
            hostname = msg.subarray(i + 2, i + 2 + optLen).toString("ascii").toLowerCase();
          }
          i += 2 + optLen;
        }

        const isReolinkHostname = hostname.startsWith("reolink");

        if (!isReolinkMac && !isReolinkHostname) return;

        // Get IP: prefer yiaddr (server-assigned), fallback to ciaddr
        const yiaddr = `${msg[16]}.${msg[17]}.${msg[18]}.${msg[19]}`;
        const ciaddr = `${msg[12]}.${msg[13]}.${msg[14]}.${msg[15]}`;
        const ip = yiaddr !== "0.0.0.0" ? yiaddr : ciaddr;
        if (ip === "0.0.0.0" || !ip) return;

        if (!discovered.has(ip)) {
          logger?.log?.(`[Discovery] DHCP: found Reolink device ${ip} (MAC: ${mac}, hostname: ${hostname || "n/a"}, op: ${op === 1 ? "request" : "reply"})`);
          const device: DiscoveredDevice = {
            host: ip,
            discoveryMethod: "dhcp" as any,
          };
          if (hostname) device.name = hostname;
          discovered.set(ip, device);
        }
      } catch {
        // ignore parse errors
      }
    });

    socket.on("error", (err) => {
      logger?.warn?.(`[Discovery] DHCP socket error: ${err.message}`);
      clearTimeout(timeout);
      socket.close();
      resolve(Array.from(discovered.values()));
    });

    socket.bind(67, "0.0.0.0", () => {
      logger?.log?.("[Discovery] DHCP listener bound on port 67");
      timeout = setTimeout(() => {
        socket.close();
        logger?.log?.(`[Discovery] DHCP listener complete. Found ${discovered.size} device(s).`);
        resolve(Array.from(discovered.values()));
      }, timeoutMs);
    });
  });
}

/**
 * Probe a single IP for an open TCP port 9000 (Baichuan protocol).
 * Returns true if the port is open (connection succeeds), false otherwise.
 */
function probeTcpPort(ip: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (result: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
    socket.connect(port, ip);
  });
}

/**
 * Discover Reolink devices by scanning TCP port 9000 (Baichuan protocol).
 * This is the most reliable method — every Reolink camera/NVR listens on port 9000.
 * It only checks if the port is open; it does not authenticate or extract device info.
 */
export async function discoverViaTcpPortScan(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableTcpPortScan) return [];

  const logger = options.logger;
  const networkCidr = options.networkCidr ?? getLocalNetworks()[0];
  const timeoutMs = options.tcpProbeTimeoutMs ?? 1500;
  const maxConcurrent = options.maxConcurrentProbes ?? 80;

  if (!networkCidr) {
    logger?.warn?.("[Discovery] No network CIDR available for TCP port scan");
    return [];
  }

  logger?.log?.(`[Discovery] Starting TCP port 9000 scan on network ${networkCidr}...`);

  const ipRange = parseCidr(networkCidr);
  if (!ipRange) {
    logger?.warn?.(`[Discovery] Invalid CIDR: ${networkCidr}`);
    return [];
  }

  const discovered: DiscoveredDevice[] = [];
  const ipAddresses: string[] = [];

  for (let ipNum = ipRange.start; ipNum <= ipRange.end && ipNum <= ipRange.start + 254; ipNum++) {
    ipAddresses.push(ipNumberToString(ipNum));
  }

  logger?.log?.(`[Discovery] Scanning ${ipAddresses.length} IPs on port 9000...`);

  for (let i = 0; i < ipAddresses.length; i += maxConcurrent) {
    const batch = ipAddresses.slice(i, i + maxConcurrent);
    const batchResults = await Promise.allSettled(
      batch.map(async (ip) => {
        const open = await probeTcpPort(ip, 9000, timeoutMs);
        if (open) {
          logger?.log?.(`[Discovery] Found Baichuan device at ${ip}:9000`);
          return { host: ip, discoveryMethod: "tcp_port_scan" as const };
        }
        return null;
      }),
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value) {
        discovered.push(result.value);
      }
    }
  }

  logger?.log?.(`[Discovery] TCP port scan complete. Found ${discovered.length} device(s).`);
  return discovered;
}

/**
 * Discover devices via ONVIF WS-Discovery (multicast probe on 239.255.255.250:3702).
 * Most Reolink cameras and NVRs support ONVIF and will respond with their service
 * endpoint (XAddrs), model, and scopes. This is the standard IP camera discovery
 * mechanism used by NVRs, VMS, and similar software.
 */
export async function discoverViaOnvif(options: DiscoveryOptions): Promise<DiscoveredDevice[]> {
  if (!options.enableOnvifDiscovery) return [];

  const logger = options.logger;
  const timeoutMs = options.onvifDiscoveryTimeoutMs ?? 5000;
  logger?.log?.(`[Discovery] Starting ONVIF WS-Discovery (${timeoutMs}ms)...`);

  const discovered = new Map<string, DiscoveredDevice>();

  // WS-Discovery multicast address and port
  const MULTICAST_ADDR = "239.255.255.250";
  const MULTICAST_PORT = 3702;

  // Build WS-Discovery Probe SOAP message targeting NetworkVideoTransmitter
  const messageId = `uuid:${randomUUID()}`;
  const probeMessage = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"',
    '  xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"',
    '  xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"',
    '  xmlns:dn="http://www.onvif.org/ver10/network/wsdl">',
    "  <s:Header>",
    `    <a:MessageID>${messageId}</a:MessageID>`,
    '    <a:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</a:To>',
    '    <a:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>',
    "  </s:Header>",
    "  <s:Body>",
    "    <d:Probe>",
    "      <d:Types>dn:NetworkVideoTransmitter</d:Types>",
    "    </d:Probe>",
    "  </s:Body>",
    "</s:Envelope>",
  ].join("\n");

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    let timeout: NodeJS.Timeout;

    socket.on("message", (msg, rinfo) => {
      try {
        const xml = msg.toString("utf8");

        // Extract XAddrs (service endpoint URL) — contains the device IP/port
        const xaddrsMatch = /<[^:]*:?XAddrs>([^<]+)<\/[^:]*:?XAddrs>/i.exec(xml);
        const scopesMatch = /<[^:]*:?Scopes>([^<]+)<\/[^:]*:?Scopes>/i.exec(xml);

        // Parse IP from XAddrs or fall back to rinfo
        let host = rinfo.address;
        let httpPort: number | undefined;
        if (xaddrsMatch?.[1]) {
          // XAddrs may contain multiple URLs separated by spaces
          const urls = xaddrsMatch[1].trim().split(/\s+/);
          for (const url of urls) {
            try {
              const parsed = new URL(url);
              if (parsed.hostname) {
                host = parsed.hostname;
                const p = Number.parseInt(parsed.port, 10);
                if (p && p !== 80) httpPort = p;
                break;
              }
            } catch {
              // ignore malformed URL
            }
          }
        }

        if (discovered.has(host)) return;

        // Parse scopes for model, name, manufacturer
        let model: string | undefined;
        let name: string | undefined;
        let manufacturer: string | undefined;
        if (scopesMatch?.[1]) {
          const scopes = scopesMatch[1].trim().split(/\s+/);
          for (const scope of scopes) {
            // Common ONVIF scope formats:
            // onvif://www.onvif.org/hardware/RLC-810A
            // onvif://www.onvif.org/name/IPC
            // onvif://www.onvif.org/manufacturer/Reolink
            const hwMatch = /\/hardware\/(.+)$/i.exec(scope);
            if (hwMatch?.[1]) model = decodeURIComponent(hwMatch[1]);
            const nameMatch = /\/name\/(.+)$/i.exec(scope);
            if (nameMatch?.[1]) name = decodeURIComponent(nameMatch[1]);
            const mfgMatch = /\/manufacturer\/(.+)$/i.exec(scope);
            if (mfgMatch?.[1]) manufacturer = decodeURIComponent(mfgMatch[1]);
          }
        }

        // Filter: only keep Reolink devices.
        // 1. Check if manufacturer/model/XAddrs explicitly contain "reolink"
        // 2. Check if the model matches known Reolink naming patterns
        // 3. Check if the device name is "IPC" (generic Reolink ONVIF name) with a known model pattern
        const allText = `${manufacturer ?? ""} ${model ?? ""} ${xaddrsMatch?.[1] ?? ""}`.toLowerCase();
        const hasReolinkText = allText.includes("reolink");
        const hasReolinkModel = /^(rlc|rln|rl[ncb]|e1|cw|cx|duo|trackmix|argus|lumus|go|video doorbell|reolink)/i.test(model ?? "");
        const isReolink = hasReolinkText || hasReolinkModel;
        if (!isReolink) {
          logger?.debug?.(`[Discovery] ONVIF: skipping non-Reolink device at ${host} (${model ?? "unknown"}, manufacturer: ${manufacturer ?? "unknown"})`);
          return;
        }

        logger?.log?.(`[Discovery] ONVIF: found Reolink device at ${host}${model ? ` (${model})` : ""}${name ? ` name="${name}"` : ""}`);

        const device: DiscoveredDevice = {
          host,
          discoveryMethod: "onvif",
        };
        if (model) device.model = model;
        // Reolink cameras often report "IPC" as name — use model instead
        if (name && name !== "IPC") {
          device.name = name;
        } else if (model) {
          device.name = model;
        }
        if (httpPort) device.httpPort = httpPort;
        discovered.set(host, device);
      } catch {
        // ignore parse errors
      }
    });

    socket.on("error", (err) => {
      logger?.warn?.(`[Discovery] ONVIF socket error: ${err.message}`);
    });

    socket.bind(0, "0.0.0.0", () => {
      // Send the probe message to multicast address
      const buf = Buffer.from(probeMessage, "utf8");
      socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, (err) => {
        if (err) {
          logger?.warn?.(`[Discovery] ONVIF: failed to send probe: ${err.message}`);
        }
      });

      // Send a second probe after a short delay (some devices miss the first)
      setTimeout(() => {
        try {
          socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR);
        } catch {
          // ignore
        }
      }, 500);

      timeout = setTimeout(() => {
        try { socket.close(); } catch { /* ignore */ }
        logger?.log?.(`[Discovery] ONVIF WS-Discovery complete. Found ${discovered.size} device(s).`);
        resolve(Array.from(discovered.values()));
      }, timeoutMs);
    });

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
  const [httpDevices, udpDevices, tcpDevices, arpDevices, dhcpDevices, onvifDevices] = await Promise.all([
    discoverViaHttpScan(options),
    discoverViaUdpBroadcast(options),
    discoverViaTcpPortScan(options),
    discoverViaArpTable(options),
    discoverViaDhcpListener(options),
    discoverViaOnvif(options),
  ]);

  // Merge results (cheapest first, then richer methods override)
  for (const device of dhcpDevices) {
    mergeDevice(device);
  }
  for (const device of arpDevices) {
    mergeDevice(device);
  }
  for (const device of tcpDevices) {
    mergeDevice(device);
  }
  for (const device of onvifDevices) {
    mergeDevice(device);
  }
  for (const device of httpDevices) {
    mergeDevice(device);
  }
  for (const device of udpDevices) {
    mergeDevice(device);
  }

  logger?.log?.(`[Discovery] Discovery complete. Found ${results.length} unique device(s).`);
  return results;
}

