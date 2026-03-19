import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import { getSettings } from "../settings-store.js";
import { getConfig } from "../settings-store.js";
import {
  getAllRtspServersInfo,
  sanitizeCameraName,
  buildGo2rtcStreamName,
} from "../rtsp-manager.js";
import { FrigateClient } from "../frigate-client.js";
import { getOrCreateApiConnection } from "../rtsp-manager.js";

// ---------------------------------------------------------------------------
// Frigate config backup system (max 20 backups, FIFO)
// ---------------------------------------------------------------------------
const MAX_BACKUPS = 20;
const BACKUP_DIR = path.join(process.env.DATA_PATH || ".", "frigate-backups");

export interface BackupEntry {
  id: string;
  timestamp: string;
  summary: string;
  filename: string;
}

function ensureBackupDir(): void {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function getBackupIndexPath(): string {
  return path.join(BACKUP_DIR, "index.json");
}

function loadBackupIndex(): BackupEntry[] {
  const indexPath = getBackupIndexPath();
  try {
    return JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  } catch {
    return [];
  }
}

function saveBackupIndex(entries: BackupEntry[]): void {
  ensureBackupDir();
  fs.writeFileSync(getBackupIndexPath(), JSON.stringify(entries, null, 2));
}

function createBackup(yamlBefore: string, summary: string): BackupEntry {
  ensureBackupDir();
  const now = new Date();
  const id = now.toISOString().replace(/[:.]/g, "-");
  const filename = `frigate-config-${id}.yaml`;
  fs.writeFileSync(path.join(BACKUP_DIR, filename), yamlBefore);

  const entry: BackupEntry = {
    id,
    timestamp: now.toISOString(),
    summary,
    filename,
  };

  const index = loadBackupIndex();
  index.push(entry);

  // Prune old backups beyond MAX_BACKUPS
  while (index.length > MAX_BACKUPS) {
    const removed = index.shift()!;
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, removed.filename));
    } catch { /* file may already be gone */ }
  }

  saveBackupIndex(index);
  return entry;
}

function buildChangeSummary(
  beforeYaml: string,
  afterConfig: Record<string, any>,
  removedNames: string[],
  addedOrUpdated: string[],
): string {
  const parts: string[] = [];
  if (addedOrUpdated.length > 0) {
    parts.push(`updated: ${addedOrUpdated.join(", ")}`);
  }
  if (removedNames.length > 0) {
    parts.push(`removed: ${removedNames.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "config update";
}

// ---------------------------------------------------------------------------
// Shared input schema for Frigate connection params (from form, not settings)
// ---------------------------------------------------------------------------

const FrigateConnectionInput = z.object({
  host: z.string().min(1),
  username: z.string().default(""),
  password: z.string().default(""),
});

function createClientFromInput(input: z.infer<typeof FrigateConnectionInput>): FrigateClient {
  return new FrigateClient({
    host: input.host,
    username: input.username || undefined,
    password: input.password || undefined,
  });
}

/** Get Frigate client from saved settings (for operations that don't receive form values). */
function createClientFromSettings(): FrigateClient {
  const settings = getSettings();
  if (!settings.frigate?.host) {
    throw new Error("Frigate host is not configured. Set it in Settings → Frigate.");
  }
  return new FrigateClient({
    host: settings.frigate.host,
    username: settings.frigate.username || undefined,
    password: settings.frigate.password || undefined,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResolution(res?: string): { width: number; height: number } | null {
  if (!res) return null;
  const m = res.match(/^(\d+)x(\d+)$/);
  if (!m) return null;
  return { width: parseInt(m[1]!, 10), height: parseInt(m[2]!, 10) };
}

/** Build the camera block for Frigate config (as a JS object, not YAML). */
interface StreamInput {
  profile: string;
  go2rtcName: string;
  rtspUrl: string;
  resolution?: string;
  codec?: string;
}

/** Common Frigate RTSP presets. */
const FRIGATE_INPUT_PRESETS = [
  "preset-rtsp-generic",
  "preset-rtsp-restream",
  "preset-rtsp-udp",
  "preset-rtsp-blue-iris",
] as const;

const FRIGATE_HWACCEL_PRESETS = [
  "",
  "preset-intel-qsv-h264",
  "preset-intel-qsv-h265",
  "preset-nvidia-h264",
  "preset-nvidia-h265",
  "preset-vaapi",
  "preset-rpi-64-h264",
  "preset-rpi-64-h265",
] as const;

function buildFrigateCameraBlock(
  streams: StreamInput[],
  useNodelinkRestream: boolean,
  inputArgs?: string,
  hwaccelArgs?: string,
): Record<string, any> {
  // Sort: highest res first
  const sorted = [...streams].sort((a, b) => {
    const pa = parseResolution(a.resolution);
    const pb = parseResolution(b.resolution);
    return ((pb?.width ?? 0) * (pb?.height ?? 0)) - ((pa?.width ?? 0) * (pa?.height ?? 0));
  });

  // Assign roles
  const inputs: Array<Record<string, any>> = [];

  const buildInput = (s: StreamInput, roles: string[]) => {
    const path = useNodelinkRestream
      ? s.rtspUrl
      : `rtsp://127.0.0.1:8554/${s.go2rtcName}`;
    const inp: Record<string, any> = { path, roles };
    if (inputArgs) inp.input_args = inputArgs;
    if (hwaccelArgs) inp.hwaccel_args = hwaccelArgs;
    return inp;
  };

  // Main stream → audio role
  if (sorted[0]) {
    inputs.push(buildInput(sorted[0], ["audio"]));
  }

  // Detect: prefer sub/ext ≤720p
  const detectStream =
    sorted.find((s) => {
      if (s.profile === "main") return false;
      const r = parseResolution(s.resolution);
      return r ? r.height <= 720 : true;
    }) ?? sorted[sorted.length - 1];

  if (detectStream && detectStream !== sorted[0]) {
    inputs.push(buildInput(detectStream, ["detect"]));
  } else if (sorted[0]) {
    inputs[0]!.roles.push("detect");
  }

  const block: Record<string, any> = {
    enabled: true,
    ffmpeg: { inputs },
    detect: { enabled: true },
    record: { enabled: false },
    snapshots: { enabled: true },
    audio: { enabled: true },
  };

  return block;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const frigateRouter = router({
  /** Test connection to Frigate (uses form values, not saved settings). */
  ping: publicProcedure
    .meta({ description: "Test connection to Frigate server" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      return client.ping();
    }),

  /** Get current Frigate config (JSON). */
  getConfig: publicProcedure
    .meta({ description: "Get current Frigate configuration" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      return client.getConfig();
    }),

  /** Get existing camera names in Frigate (from saved YAML, not in-memory). */
  getCameras: publicProcedure
    .meta({ description: "List cameras currently configured in Frigate" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;
      const cameras = frigateConfig.cameras;
      if (!cameras || typeof cameras !== "object") return [];
      return Object.keys(cameras);
    }),

  /** Get go2rtc streams configured in Frigate. */
  getGo2rtcStreams: publicProcedure
    .meta({ description: "List go2rtc streams in Frigate config" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      return client.getGo2rtcStreams();
    }),

  /**
   * Get Frigate system info: detected hwaccel presets, global ffmpeg config, etc.
   * Used to auto-select the right hwaccel_args per codec when adding cameras.
   */
  getSystemInfo: publicProcedure
    .meta({ description: "Get Frigate system-level config (hwaccel, ffmpeg defaults)" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      // Extract global ffmpeg hwaccel_args
      const globalHwaccel: string = frigateConfig.ffmpeg?.hwaccel_args ?? "";
      const globalInputArgs: string = frigateConfig.ffmpeg?.input_args ?? "";

      // Detect hwaccel family from the global preset or per-camera presets
      let hwaccelFamily: string | null = null;
      const detectFamily = (preset: string): string | null => {
        if (/intel.*qsv/i.test(preset)) return "intel-qsv";
        if (/nvidia/i.test(preset)) return "nvidia";
        if (/vaapi/i.test(preset)) return "vaapi";
        if (/rpi/i.test(preset)) return "rpi";
        return null;
      };

      hwaccelFamily = detectFamily(globalHwaccel);

      // If no global, scan cameras for a per-input hwaccel preset
      if (!hwaccelFamily) {
        const cameras = frigateConfig.cameras ?? {};
        outer: for (const cam of Object.values(cameras)) {
          for (const inp of (cam as any)?.ffmpeg?.inputs ?? []) {
            const ha = inp.hwaccel_args ?? "";
            const family = detectFamily(ha);
            if (family) {
              hwaccelFamily = family;
              break outer;
            }
          }
        }
      }

      return {
        globalHwaccel,
        globalInputArgs,
        hwaccelFamily,
      };
    }),

  /** Get the existing YAML block for a specific Frigate camera (raw text from file). */
  getCameraYaml: publicProcedure
    .meta({ description: "Get the existing YAML config block for a Frigate camera" })
    .input(FrigateConnectionInput.extend({ cameraName: z.string() }))
    .query(async ({ input }) => {
      const client = createClientFromInput(input);
      const rawYaml = await client.getRawConfig();

      // Extract the camera block as raw text to preserve comments & formatting.
      // Find "  {cameraName}:" under the "cameras:" section and grab until the
      // next sibling key at the same indent level.
      const lines = rawYaml.split("\n");
      const cameraHeader = `  ${input.cameraName}:`;
      let startIdx = -1;
      let inCamerasSection = false;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/^cameras\s*:/.test(line)) {
          inCamerasSection = true;
          continue;
        }
        if (inCamerasSection && line === cameraHeader) {
          startIdx = i;
          break;
        }
        // Exited cameras section (new top-level key)
        if (inCamerasSection && /^\S/.test(line) && !line.startsWith("#")) {
          inCamerasSection = false;
        }
      }

      if (startIdx === -1) {
        // Fallback: parse + serialize
        const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;
        const cam = frigateConfig.cameras?.[input.cameraName];
        if (!cam) return { found: false, yaml: "", block: null };
        const yaml = YAML.stringify(
          { [input.cameraName]: cam },
          { lineWidth: 0, defaultStringType: "PLAIN" },
        ).trimEnd();
        return { found: true, yaml, block: cam };
      }

      // Find the end: next sibling at 2-space indent (same level as camera name)
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        const line = lines[i]!;
        // Another camera at same indent level, or a new top-level section
        if (/^  \S/.test(line) && !line.startsWith("  #") && !line.startsWith("    ")) {
          endIdx = i;
          break;
        }
        if (/^\S/.test(line) && !line.startsWith("#")) {
          endIdx = i;
          break;
        }
      }

      // Trim trailing blank lines
      while (endIdx > startIdx && lines[endIdx - 1]?.trim() === "") endIdx--;

      const rawBlock = lines.slice(startIdx, endIdx).join("\n");

      // Also parse for the block object
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;
      const block = frigateConfig.cameras?.[input.cameraName] ?? null;

      return { found: true, yaml: rawBlock, block };
    }),

  /**
   * Match existing Frigate cameras against nodelink cameras by RTSP URL.
   * A Frigate camera is "managed by nodelink" if any of its ffmpeg input URLs
   * or associated go2rtc stream sources match the RTSP URLs nodelink would
   * generate for a given camera (e.g. rtsp://host:port/camera_name_main).
   */
  match: publicProcedure
    .meta({ description: "Match Frigate cameras to nodelink cameras by URL" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const settings = getSettings();
      const config = getConfig();
      const go2rtcRtspPort = settings.go2rtc?.rtspPort ?? 18554;
      const serviceIp = settings.serviceIp || "localhost";

      const client = createClientFromInput(input);
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      const frigateCameras = frigateConfig.cameras ?? {};
      const frigateGo2rtc = frigateConfig.go2rtc?.streams ?? {};

      // Build the full set of nodelink RTSP URLs for each camera.
      // A Frigate camera is "managed" only if its input URL exactly matches
      // one of these (scheme://host:port/path).
      const nodelinkUrlToCam = new Map<string, { id: string; name: string; host: string }>();
      for (const nlCam of config.cameras) {
        const channel = nlCam.rtspChannel ?? 0;
        for (const profile of ["main", "sub", "ext"]) {
          const go2rtcName = buildGo2rtcStreamName(nlCam.name, profile, channel);
          const fullUrl = `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`.toLowerCase();
          nodelinkUrlToCam.set(fullUrl, {
            id: nlCam.id,
            name: nlCam.name,
            host: nlCam.host,
          });
        }
      }

      const results: Array<{
        frigateName: string;
        frigateEnabled: boolean;
        frigateInputs: Array<{ path: string; roles: string[] }>;
        matchedNodelinkCamera?: { id: string; name: string; host: string };
      }> = [];

      for (const [fName, fCam] of Object.entries(frigateCameras)) {
        const cam = fCam as any;
        const inputs = (cam?.ffmpeg?.inputs ?? []).map((i: any) => ({
          path: i.path ?? "",
          roles: i.roles ?? [],
        }));

        // Collect all URLs: ffmpeg inputs + go2rtc stream sources for this camera
        const allUrls: string[] = inputs.map((i: { path: string }) => i.path.toLowerCase());
        for (const [streamName, streamSrc] of Object.entries(frigateGo2rtc)) {
          if (streamName.startsWith(`${fName}_`) || streamName === fName) {
            const srcStr = Array.isArray(streamSrc) ? streamSrc[0] : String(streamSrc ?? "");
            if (srcStr) allUrls.push(srcStr.toLowerCase());
          }
        }

        // Exact URL match against known nodelink RTSP URLs
        let matchedCamera: { id: string; name: string; host: string } | undefined;
        for (const url of allUrls) {
          // Strip trailing slashes or query strings for comparison
          const normalized = url.split("?")[0]!.replace(/\/+$/, "");
          const found = nodelinkUrlToCam.get(normalized);
          if (found) {
            matchedCamera = found;
            break;
          }
        }

        results.push({
          frigateName: fName,
          frigateEnabled: cam?.enabled !== false,
          frigateInputs: inputs,
          matchedNodelinkCamera: matchedCamera,
        });
      }

      return { cameras: results };
    }),

  /**
   * Remove cameras from Frigate config by name.
   */
  removeCameras: publicProcedure
    .meta({ description: "Remove cameras from Frigate config" })
    .input(
      FrigateConnectionInput.extend({
        cameraNames: z.array(z.string()),
        restart: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const client = createClientFromInput(input);
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      if (!frigateConfig.cameras) frigateConfig.cameras = {};

      for (const name of input.cameraNames) {
        delete frigateConfig.cameras[name];
        // Also remove associated go2rtc streams
        if (frigateConfig.go2rtc?.streams) {
          for (const key of Object.keys(frigateConfig.go2rtc.streams)) {
            if (key.startsWith(`${name}_`) || key === name) {
              delete frigateConfig.go2rtc.streams[key];
            }
          }
        }
      }

      const outputYaml = YAML.stringify(frigateConfig, {
        lineWidth: 0,
        defaultKeyType: "PLAIN",
        defaultStringType: "PLAIN",
      });
      return client.saveRawConfig(outputYaml, input.restart);
    }),

  /**
   * Generate a preview of what would be added/updated in Frigate config.
   * Does NOT save — just returns the proposed changes.
   */
  preview: publicProcedure
    .meta({
      description:
        "Preview Frigate config changes for selected cameras without saving",
    })
    .input(
      z.object({
        /** Camera IDs to include. */
        cameraIds: z.array(z.string()),
      }),
    )
    .query(async ({ input }) => {
      const settings = getSettings();
      const config = getConfig();
      const rtspServers = getAllRtspServersInfo();
      const go2rtcRtspPort = settings.go2rtc?.rtspPort ?? 18554;
      const serviceIp = settings.serviceIp || "localhost";

      const camerasToAdd: Array<{
        cameraId: string;
        cameraName: string;
        frigateName: string;
        alreadyInFrigate: boolean;
        block: Record<string, any>;
        yaml: string;
        go2rtcStreams: Record<string, string>;
        go2rtcYaml: string;
        /** Stream info with codec/resolution for display. */
        streamInfo: Array<{
          profile: string;
          go2rtcName: string;
          rtspUrl: string;
          roles: string[];
          resolution?: string;
          codec?: string;
        }>;
      }> = [];

      for (const cameraId of input.cameraIds) {
        const camera = config.cameras.find((c) => c.id === cameraId);
        if (!camera) continue;

        const frigateName = sanitizeCameraName(camera.name);
        const channel = camera.rtspChannel ?? 0;

        // Build streams from native video stream options (all available profiles)
        // rather than only from currently-running RTSP servers.
        // This way disconnected cameras still show all 3 streams (main/sub/ext).
        let streams: StreamInput[] = [];
        try {
          const api = await getOrCreateApiConnection(cameraId);
          const isNvr = camera.isNvr || !!camera.nvrId;
          const streamOpts = await api.buildVideoStreamOptions({ channel, onNvr: isNvr });
          streams = streamOpts.nativeStreams.map((s: any) => {
            const profile: string = s.profile ?? "main";
            const ch: number = s.channel ?? channel;
            const go2rtcName = buildGo2rtcStreamName(camera.name, profile, ch);
            return {
              profile,
              go2rtcName,
              rtspUrl: `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`,
              resolution: s.metadata ? `${s.metadata.width}x${s.metadata.height}` : undefined,
              codec: s.metadata?.videoEncType,
            };
          });
        } catch {
          // Camera not reachable — fall back to running RTSP servers
          const cameraRtsp = rtspServers.filter(
            (s) => s.cameraId === cameraId && s.status === "running",
          );
          if (cameraRtsp.length > 0) {
            streams = cameraRtsp.map((s) => {
              const go2rtcName = buildGo2rtcStreamName(camera.name, s.profile, s.channel);
              return {
                profile: s.profile,
                go2rtcName,
                rtspUrl: `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`,
                resolution: undefined,
                codec: undefined,
              };
            });
          } else {
            // No running RTSP servers either — generate default stream entries
            // so the camera can still be configured in Frigate
            const defaultProfiles = ["main", "sub", "ext"];
            streams = defaultProfiles.map((profile) => ({
              profile,
              go2rtcName: buildGo2rtcStreamName(camera.name, profile, channel),
              rtspUrl: `rtsp://${serviceIp}:${go2rtcRtspPort}/${buildGo2rtcStreamName(camera.name, profile, channel)}`,
              resolution: undefined,
              codec: undefined,
            }));
          }
        }

        // Preview always uses direct RTSP (nodelink) as default.
        // Per-camera _useFrigateGo2rtc override is applied client-side in rebuildYaml.
        const block = buildFrigateCameraBlock(streams, true);

        // go2rtc streams are populated client-side when _useFrigateGo2rtc is toggled
        const go2rtcStreams: Record<string, string> = {};

        // Generate YAML preview using the yaml package
        const cameraYaml = YAML.stringify(
          { [frigateName]: block },
          { lineWidth: 0, defaultStringType: "PLAIN" },
        ).trimEnd();
        let go2rtcYaml = "";
        if (Object.keys(go2rtcStreams).length > 0) {
          go2rtcYaml = YAML.stringify(
            go2rtcStreams,
            { lineWidth: 0, defaultStringType: "PLAIN" },
          ).trimEnd();
        }

        // Build streamInfo with roles assigned
        const streamInfo = streams.map((s) => {
          const inp = block.ffmpeg?.inputs ?? [];
          const matchedInput = (inp as any[]).find((i: any) =>
            (i.path ?? "").includes(s.go2rtcName),
          );
          return {
            profile: s.profile,
            go2rtcName: s.go2rtcName,
            rtspUrl: s.rtspUrl,
            resolution: s.resolution,
            codec: s.codec,
            roles: matchedInput?.roles ?? [],
          };
        });

        camerasToAdd.push({
          cameraId,
          cameraName: camera.name,
          frigateName,
          alreadyInFrigate: false, // client checks this from cached frigateExistingCameras
          block,
          yaml: cameraYaml,
          go2rtcStreams,
          go2rtcYaml,
          streamInfo,
        });
      }

      return {
        cameras: camerasToAdd,
        presets: {
          inputArgs: FRIGATE_INPUT_PRESETS as unknown as string[],
          hwaccelArgs: FRIGATE_HWACCEL_PRESETS as unknown as string[],
        },
      };
    }),

  /**
   * Apply camera config to Frigate.
   * Reads current config, merges selected cameras, optionally removes deselected ones.
   */
  apply: publicProcedure
    .meta({
      description:
        "Apply camera configuration to Frigate (merge selected, remove deselected)",
    })
    .input(
      FrigateConnectionInput.extend({
        /** Camera blocks to merge into Frigate config, keyed by Frigate camera name.
         *  Each value is the YAML text for that camera (parsed server-side). */
        cameras: z.record(z.string(), z.string()),
        /** go2rtc stream definitions to merge (for Frigate go2rtc restream mode). */
        go2rtcStreams: z.record(z.string(), z.string()).default({}),
        /** Frigate camera names to remove. */
        removeNames: z.array(z.string()).default([]),
        /** Whether to restart Frigate after saving. */
        restart: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const client = createClientFromInput(input);

      // Read current config
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      if (!frigateConfig.cameras) frigateConfig.cameras = {};
      if (!frigateConfig.go2rtc) frigateConfig.go2rtc = {};
      if (!frigateConfig.go2rtc.streams) frigateConfig.go2rtc.streams = {};

      // Backup before making changes
      const addedOrUpdated = Object.keys(input.cameras);
      const summary = buildChangeSummary(rawYaml, frigateConfig, input.removeNames, addedOrUpdated);
      createBackup(rawYaml, summary);

      // Remove deselected cameras
      for (const name of input.removeNames) {
        delete frigateConfig.cameras[name];
        for (const key of Object.keys(frigateConfig.go2rtc.streams)) {
          if (key.startsWith(`${name}_`)) {
            delete frigateConfig.go2rtc.streams[key];
          }
        }
      }

      // Merge camera blocks from the client preview YAML
      for (const [frigateName, yamlText] of Object.entries(input.cameras)) {
        const parsed = YAML.parse(yamlText) as Record<string, any>;
        const block = parsed[frigateName] ?? parsed;
        frigateConfig.cameras[frigateName] = block;
      }

      // Merge go2rtc streams
      for (const [streamName, streamUrl] of Object.entries(input.go2rtcStreams)) {
        frigateConfig.go2rtc.streams[streamName] = streamUrl;
      }

      const outputYaml = YAML.stringify(frigateConfig, {
        lineWidth: 0,
        defaultKeyType: "PLAIN",
        defaultStringType: "PLAIN",
      });
      const result = await client.saveRawConfig(outputYaml, input.restart);
      return result;
    }),

  /** Restart Frigate. */
  restart: publicProcedure
    .meta({ description: "Restart Frigate server" })
    .input(FrigateConnectionInput)
    .mutation(async ({ input }) => {
      const client = createClientFromInput(input);
      return client.restart();
    }),

  // ── Backup management ────────────────────────────────────────────────

  /** List available config backups (newest first). */
  listBackups: publicProcedure
    .meta({ description: "List Frigate config backups" })
    .query(() => {
      return loadBackupIndex().reverse();
    }),

  /** Rollback to a specific backup. */
  rollback: publicProcedure
    .meta({ description: "Rollback Frigate config to a backup" })
    .input(
      FrigateConnectionInput.extend({
        backupId: z.string(),
        restart: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const index = loadBackupIndex();
      const entry = index.find((e) => e.id === input.backupId);
      if (!entry) {
        return { success: false, error: "Backup not found" };
      }

      const backupPath = path.join(BACKUP_DIR, entry.filename);
      if (!fs.existsSync(backupPath)) {
        return { success: false, error: "Backup file missing" };
      }

      const client = createClientFromInput(input);

      // Backup the current config before rolling back
      const currentYaml = await client.getRawConfig();
      createBackup(currentYaml, `rollback to ${entry.id}`);

      // Restore
      const backupYaml = fs.readFileSync(backupPath, "utf-8");
      const result = await client.saveRawConfig(backupYaml, input.restart);
      return result;
    }),
});
