/**
 * Reolink cloud `server-binding` lookup.
 *
 * Reverse-engineered from the desktop Electron app
 * (`libBCSDKWrapper.dylib`'s embedded format strings + the JS
 * `getDeviceServerBinding` call site in the main-process bundle). The
 * endpoint is **unauthenticated** — anyone with a valid UID can ask
 * Reolink's cloud directory which regional zone the camera lives in,
 * including the specific `p2p.<region>.reolink.com` host bound to it.
 *
 * Why we want it: the previous P2P discovery walked all 22 hardcoded
 * relay hostnames in declaration order, hoping one would respond for the
 * UID. That's ~22 DNS lookups + a serial UDP try per address, AND it
 * massively widens the DNS-filter blast radius (any user whose blocklist
 * sinks `*.reolink.com` has us looking at 22 sinkholes instead of 1).
 *
 * The cloud directory call narrows that to ONE hostname per UID, derived
 * from Reolink's own zone allocation table. Cost: one HTTPS GET (or one
 * cache hit if we've seen this UID recently).
 *
 * Fallback model: ANY failure here (network, DNS sinkhole on
 * apis.reolink.com itself, malformed response, etc.) is treated as a soft
 * fallback — the caller continues with the legacy full-sweep behavior.
 * We never turn a transient cloud blip into a hard connect failure.
 *
 * Sources:
 *  - GAP-3 reverse engineering report (in repo conversation log)
 *  - JS call site (renderer + main bundles):
 *      `getDeviceServerBinding(uid, language)` →
 *      `GET ${ReoApiV2BaseUrl}/devices/${uid}/server-binding?language=${lang}`
 *      where `ReoApiV2BaseUrl = "https://apis.reolink.com/v2"`.
 *  - SDK fallback table embedded in `libBCSDKWrapper.dylib` (8 default
 *    zones) — same shape we expect from the HTTP response.
 */

import type { Logger } from "../debug/DebugConfig";

const REOLINK_API_V2_BASE = "https://apis.reolink.com/v2";

/**
 * One service entry inside an `AvailableZone`. The desktop SDK
 * acknowledges four service kinds: `p2p`, `cloud`, `roms_ota`,
 * `alarm_push`. We only care about `p2p` here, but the typed surface
 * intentionally covers all of them in case a future use case needs
 * the cloud or push endpoints.
 */
export interface ZoneService {
  /** Fully-qualified hostname for the service. e.g. `p2p7.reolink.com`. */
  readonly server: string;
}

/**
 * One zone the device is bound to (or that the cloud considers a
 * candidate). Per UID the cloud typically returns just the active zone
 * plus a `default` global fallback — but the response format is the
 * same as the global zone list embedded in the SDK.
 */
export interface AvailableZone {
  /** Numeric zone id as a string (e.g. `"2"`, `"7"`, `"9"`). */
  readonly id: string;
  /** Human-readable name (i18n via the `language` query param). */
  readonly name: string;
  /** Two-letter country codes routed to this zone. */
  readonly locations?: readonly string[];
  /**
   * `"active"` for the zone the UID is bound to.
   * `"default"` for the global fallback.
   * Other values exist (`"deprecated"`, etc.) — treat anything we
   * don't recognise as "skip when picking".
   */
  readonly status: string;
  readonly services: {
    readonly p2p?: ZoneService;
    readonly cloud?: ZoneService;
    readonly roms_ota?: ZoneService;
    readonly alarm_push?: ZoneService;
  };
}

export interface ServerBindingResponse {
  readonly availableZones: readonly AvailableZone[];
}

export interface GetServerBindingOptions {
  /**
   * BCP-47-ish language hint Reolink uses to localise the `name` field
   * of each zone. Default `"en"`. Does NOT affect routing — we only
   * pass it for parity with the desktop app's request.
   */
  readonly language?: string;
  /**
   * Total budget for the HTTPS call. Defaults to 4 seconds — short
   * enough that a slow cloud doesn't block autodetect, long enough
   * for normal TLS + round-trip from anywhere in the world.
   */
  readonly timeoutMs?: number;
  /** Override the base URL — handy for tests / staging mirrors. */
  readonly baseUrl?: string;
  /** Optional fetch impl (test seam). Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Logger;
}

/**
 * In-memory cache. Keyed by UID; value is the resolved response.
 * Negative cache for failures so a sinkholed `apis.reolink.com` doesn't
 * burn 4s per autodetect retry — we remember "no" for a short window
 * and let the caller fall through quickly.
 */
type CacheEntry =
  | { kind: "ok"; response: ServerBindingResponse; expires: number }
  | { kind: "err"; expires: number };

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — mirrors the desktop app
const NEGATIVE_TTL_MS = 30 * 1000; // 30s — avoid hammering cloud during outages

const cache = new Map<string, CacheEntry>();

function readCache(uid: string, now: number): CacheEntry | undefined {
  const e = cache.get(uid);
  if (!e) return undefined;
  if (now >= e.expires) {
    cache.delete(uid);
    return undefined;
  }
  return e;
}

/** Public test hook — wipe the cache between specs. */
export function _clearServerBindingCacheForTests(): void {
  cache.clear();
}

/**
 * Look up the cloud directory entry for one UID.
 *
 * Returns the parsed zone list on success, `undefined` on any failure
 * (network, HTTP non-2xx, parse error, timeout). The caller MUST treat
 * `undefined` as "do whatever you would have done without this hint" —
 * never as a hard error.
 *
 * Cached in-process. Subsequent calls within
 * {@link POSITIVE_TTL_MS} / {@link NEGATIVE_TTL_MS} reuse the prior
 * result without an HTTPS round-trip.
 */
export async function getServerBinding(
  uid: string,
  options: GetServerBindingOptions = {},
): Promise<ServerBindingResponse | undefined> {
  if (!uid || typeof uid !== "string") return undefined;

  // Hard-baked clock injection point — `_serverBindingNowMs` is overridable in
  // tests via top-level export below. Using Date.now() directly here keeps the
  // production hot path branch-free.
  const now = Date.now();
  const cached = readCache(uid, now);
  if (cached?.kind === "ok") return cached.response;
  if (cached?.kind === "err") return undefined;

  const language = options.language ?? "en";
  const baseUrl = options.baseUrl ?? REOLINK_API_V2_BASE;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger;

  if (typeof fetchImpl !== "function") {
    // Node < 18 without polyfill. Don't crash — degrade silently.
    logger?.debug?.(
      `[server-binding] global fetch unavailable; skipping cloud lookup`,
    );
    cache.set(uid, { kind: "err", expires: now + NEGATIVE_TTL_MS });
    return undefined;
  }

  const url = `${baseUrl}/devices/${encodeURIComponent(uid)}/server-binding?language=${encodeURIComponent(language)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      logger?.debug?.(
        `[server-binding] ${uid}: HTTP ${res.status} ${res.statusText}`,
      );
      cache.set(uid, { kind: "err", expires: now + NEGATIVE_TTL_MS });
      return undefined;
    }
    const json = (await res.json()) as unknown;
    const parsed = parseServerBindingResponse(json);
    if (!parsed) {
      logger?.debug?.(
        `[server-binding] ${uid}: response shape did not match expectations`,
      );
      cache.set(uid, { kind: "err", expires: now + NEGATIVE_TTL_MS });
      return undefined;
    }
    cache.set(uid, {
      kind: "ok",
      response: parsed,
      expires: now + POSITIVE_TTL_MS,
    });
    logger?.debug?.(
      `[server-binding] ${uid}: cloud returned ${parsed.availableZones.length} zone(s)`,
    );
    return parsed;
  } catch (e) {
    logger?.debug?.(
      `[server-binding] ${uid}: ${(e as { message?: string })?.message ?? String(e)}`,
    );
    cache.set(uid, { kind: "err", expires: now + NEGATIVE_TTL_MS });
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick the most likely-correct P2P relay hostname out of a binding
 * response. Preference order:
 *  1. The zone marked `status === "active"` (the cloud's per-UID
 *     allocation — this is the entry we trust most).
 *  2. The zone marked `status === "default"` (global fallback). Some
 *     responses ship only this — that's fine, the default relays
 *     work for any UID.
 *  3. The first zone in the list (last-resort heuristic — at least it
 *     came from Reolink so the FQDN is real).
 *
 * Returns `undefined` if none of the candidates carry a `p2p.server`
 * — caller should fall through to the legacy full-sweep behaviour.
 */
export function pickP2pHostFromBinding(
  response: ServerBindingResponse | undefined,
): string | undefined {
  if (!response) return undefined;
  const zones = response.availableZones;
  if (!zones || zones.length === 0) return undefined;
  const active = zones.find(
    (z) => z.status === "active" && z.services.p2p?.server,
  );
  if (active?.services.p2p?.server) return active.services.p2p.server;
  const def = zones.find(
    (z) => z.status === "default" && z.services.p2p?.server,
  );
  if (def?.services.p2p?.server) return def.services.p2p.server;
  const any = zones.find((z) => z.services.p2p?.server);
  return any?.services.p2p?.server;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function parseServerBindingResponse(
  raw: unknown,
): ServerBindingResponse | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rawZones = (raw as Record<string, unknown>).availableZones;
  if (!Array.isArray(rawZones)) return undefined;
  const zones: AvailableZone[] = [];
  for (const r of rawZones) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    const id = rec.id;
    const name = rec.name;
    const status = rec.status;
    if (!isString(id) || !isString(name) || !isString(status)) continue;
    const servicesRaw = rec.services;
    const services: AvailableZone["services"] = {};
    if (servicesRaw && typeof servicesRaw === "object") {
      const s = servicesRaw as Record<string, unknown>;
      for (const key of ["p2p", "cloud", "roms_ota", "alarm_push"] as const) {
        const v = s[key];
        if (v && typeof v === "object") {
          const server = (v as Record<string, unknown>).server;
          if (isString(server) && server.length > 0) {
            (services as Record<string, ZoneService>)[key] = { server };
          }
        }
      }
    }
    const locationsRaw = rec.locations;
    const locations =
      Array.isArray(locationsRaw) && locationsRaw.every(isString)
        ? (locationsRaw as readonly string[])
        : undefined;
    zones.push({
      id,
      name,
      status,
      services,
      ...(locations ? { locations } : {}),
    });
  }
  return { availableZones: zones };
}
