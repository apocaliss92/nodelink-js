import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
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

  // Main → record + audio
  if (sorted[0]) {
    inputs.push(buildInput(sorted[0], ["record", "audio"]));
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

  const detectRes = parseResolution(detectStream?.resolution);
  const fps = detectRes && detectRes.height <= 480 ? 5 : 10;

  const block: Record<string, any> = {
    enabled: true,
    ffmpeg: { inputs },
  };

  if (detectRes) {
    block.detect = {
      enabled: true,
      width: detectRes.width,
      height: detectRes.height,
      fps,
    };
  }

  block.record = {
    enabled: true,
    alerts: { retain: { days: 30, mode: "motion" } },
    detections: { retain: { days: 30, mode: "motion" } },
    motion: { days: 7 },
  };

  block.snapshots = { enabled: true };
  block.audio = { enabled: true };

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
   * Match existing Frigate cameras against nodelink cameras by IP.
   * Returns a unified list with match status, existing config, etc.
   */
  match: publicProcedure
    .meta({ description: "Match Frigate cameras to nodelink cameras by IP" })
    .input(FrigateConnectionInput)
    .query(async ({ input }) => {
      const config = getConfig();
      const client = createClientFromInput(input);
      // Use raw config (reads YAML from disk) to see latest saved changes,
      // even before Frigate restarts and reloads its in-memory config.
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      const frigateCameras = frigateConfig.cameras ?? {};
      const frigateGo2rtc = frigateConfig.go2rtc?.streams ?? {};

      // Extract IPs from Frigate camera RTSP inputs
      const extractIps = (cam: any): string[] => {
        const ips: string[] = [];
        const inputs = cam?.ffmpeg?.inputs ?? [];
        for (const inp of inputs) {
          const path = inp.path ?? "";
          try {
            const m = path.match(/:\/\/([^:/@]+)/);
            if (m?.[1] && m[1] !== "127.0.0.1") ips.push(m[1]);
          } catch { /* ignore */ }
        }
        // Also check go2rtc streams that reference this camera name
        for (const [streamName, streamSrc] of Object.entries(frigateGo2rtc)) {
          const srcStr = Array.isArray(streamSrc) ? streamSrc[0] : String(streamSrc);
          if (!srcStr) continue;
          try {
            const m = srcStr.match(/:\/\/([^:/@]+)/);
            if (m?.[1] && m[1] !== "127.0.0.1") ips.push(m[1]);
          } catch { /* ignore */ }
        }
        return [...new Set(ips)];
      };

      const results: Array<{
        frigateName: string;
        frigateEnabled: boolean;
        frigateIps: string[];
        frigateInputs: Array<{ path: string; roles: string[] }>;
        matchedNodelinkCamera?: {
          id: string;
          name: string;
          host: string;
        };
        matchedByName: boolean;
        matchedByIp: boolean;
      }> = [];

      for (const [fName, fCam] of Object.entries(frigateCameras)) {
        const cam = fCam as any;
        const ips = extractIps(cam);
        const inputs = (cam?.ffmpeg?.inputs ?? []).map((i: any) => ({
          path: i.path ?? "",
          roles: i.roles ?? [],
        }));

        // Collect all RTSP paths from inputs for URL-based matching
        const allPaths = inputs.map((i: { path: string }) => i.path.toLowerCase());

        let matchedByName = false;
        let matchedByIp = false;
        let matchedCamera: { id: string; name: string; host: string } | undefined;

        // Also collect go2rtc stream URLs that reference this Frigate camera
        const go2rtcPaths: string[] = [];
        for (const [streamName, streamSrc] of Object.entries(frigateGo2rtc)) {
          if (streamName.startsWith(`${fName}_`) || streamName === fName) {
            const srcStr = Array.isArray(streamSrc) ? streamSrc[0] : String(streamSrc ?? "");
            if (srcStr) go2rtcPaths.push(srcStr.toLowerCase());
          }
        }
        const allUrls = [...allPaths, ...go2rtcPaths];

        for (const nlCam of config.cameras) {
          const sName = sanitizeCameraName(nlCam.name);

          // 1. Exact camera name match
          if (sName === fName) {
            matchedCamera = { id: nlCam.id, name: nlCam.name, host: nlCam.host };
            matchedByName = true;
            break;
          }

          // 2. Any RTSP URL (camera inputs or go2rtc streams) contains the
          //    nodelink stream name pattern: /{sName}_ or /{sName}/
          const hasUrlMatch = allUrls.some(
            (u: string) => u.includes(`/${sName}_`) || u.includes(`/${sName}/`),
          );
          if (hasUrlMatch) {
            matchedCamera = { id: nlCam.id, name: nlCam.name, host: nlCam.host };
            matchedByName = true;
            break;
          }

          // 3. Any URL contains the camera's direct IP
          const hasIpMatch = allUrls.some(
            (u: string) => u.includes(`://${nlCam.host}:`) || u.includes(`://${nlCam.host}/`),
          );
          if (hasIpMatch) {
            matchedCamera = { id: nlCam.id, name: nlCam.name, host: nlCam.host };
            matchedByIp = true;
            break;
          }
        }

        results.push({
          frigateName: fName,
          frigateEnabled: cam?.enabled !== false,
          frigateIps: ips,
          frigateInputs: inputs,
          matchedNodelinkCamera: matchedCamera,
          matchedByName,
          matchedByIp,
        });
      }

      return {
        cameras: results,
        nodelinkCameras: config.cameras.map((c) => ({
          id: c.id,
          name: c.name,
          host: c.host,
          sanitizedName: sanitizeCameraName(c.name),
        })),
      };
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
      FrigateConnectionInput.extend({
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
      const useNodelink = settings.frigate?.streamMode !== "frigate";

      // Current Frigate config (if reachable)
      let existingCameras: string[] = [];
      let existingGo2rtcStreams: Record<string, any> = {};
      try {
        const client = createClientFromInput(input);
        existingCameras = await client.getCameraNames();
        existingGo2rtcStreams = await client.getGo2rtcStreams();
      } catch {
        // Frigate not reachable — still generate the config
      }

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

        const cameraRtsp = rtspServers.filter(
          (s) => s.cameraId === cameraId && s.status === "running",
        );
        if (cameraRtsp.length === 0) continue;

        const frigateName = sanitizeCameraName(camera.name);

        // Get codec/resolution from the camera API
        let nativeStreamMeta: Array<{
          profile: string;
          resolution?: string;
          codec?: string;
          channel: number;
        }> = [];
        try {
          const api = await getOrCreateApiConnection(cameraId);
          const channel = camera.rtspChannel ?? 0;
          const isNvr = camera.isNvr || !!camera.nvrId;
          const streamOpts = await api.buildVideoStreamOptions({ channel, onNvr: isNvr });
          nativeStreamMeta = streamOpts.nativeStreams.map((s: any) => ({
            profile: s.profile,
            resolution: s.metadata ? `${s.metadata.width}x${s.metadata.height}` : undefined,
            codec: s.metadata?.videoEncType,
            channel: s.channel ?? channel,
          }));
        } catch {
          // Camera not connected or API error — continue without metadata
        }

        const streams: StreamInput[] = cameraRtsp.map((s) => {
          const go2rtcName = buildGo2rtcStreamName(camera.name, s.profile, s.channel);
          const meta = nativeStreamMeta.find(
            (m) => m.profile === s.profile && m.channel === s.channel,
          );
          return {
            profile: s.profile,
            go2rtcName,
            rtspUrl: `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`,
            resolution: meta?.resolution,
            codec: meta?.codec,
          };
        });

        const block = buildFrigateCameraBlock(streams, useNodelink);

        const go2rtcStreams: Record<string, string> = {};
        if (!useNodelink) {
          // Frigate restream mode: add streams to Frigate's own go2rtc
          for (const s of streams) {
            go2rtcStreams[s.go2rtcName] = s.rtspUrl;
          }
        }

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
          alreadyInFrigate: existingCameras.includes(frigateName),
          block,
          yaml: cameraYaml,
          go2rtcStreams,
          go2rtcYaml,
          streamInfo,
        });
      }

      return {
        cameras: camerasToAdd,
        existingCameras,
        existingGo2rtcStreams,
        streamMode: useNodelink ? "nodelink" : "frigate",
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
        /** Camera IDs to add/update. */
        cameraIds: z.array(z.string()),
        /** Frigate camera names to remove (cameras previously managed by us but now deselected). */
        removeNames: z.array(z.string()).default([]),
        /** Whether to restart Frigate after saving. */
        restart: z.boolean().default(false),
      }),
    )
    .mutation(async ({ input }) => {
      const settings = getSettings();
      const config = getConfig();
      const rtspServers = getAllRtspServersInfo();
      const go2rtcRtspPort = settings.go2rtc?.rtspPort ?? 18554;
      const serviceIp = settings.serviceIp || "localhost";
      const useNodelink = settings.frigate?.streamMode !== "frigate";

      const client = createClientFromInput(input);

      // Read current config as raw YAML, parse it, merge, serialize back.
      const rawYaml = await client.getRawConfig();
      const frigateConfig = YAML.parse(rawYaml) as Record<string, any>;

      // Ensure sections exist
      if (!frigateConfig.cameras) frigateConfig.cameras = {};
      if (!frigateConfig.go2rtc) frigateConfig.go2rtc = {};
      if (!frigateConfig.go2rtc.streams) frigateConfig.go2rtc.streams = {};

      // Remove deselected cameras
      for (const name of input.removeNames) {
        delete frigateConfig.cameras[name];
        for (const key of Object.keys(frigateConfig.go2rtc.streams)) {
          if (key.startsWith(`${name}_`)) {
            delete frigateConfig.go2rtc.streams[key];
          }
        }
      }

      // Add/update selected cameras
      for (const cameraId of input.cameraIds) {
        const camera = config.cameras.find((c) => c.id === cameraId);
        if (!camera) continue;

        const cameraRtsp = rtspServers.filter(
          (s) => s.cameraId === cameraId && s.status === "running",
        );
        if (cameraRtsp.length === 0) continue;

        const frigateName = sanitizeCameraName(camera.name);

        const streams = cameraRtsp.map((s) => {
          const go2rtcName = buildGo2rtcStreamName(camera.name, s.profile, s.channel);
          return {
            profile: s.profile,
            go2rtcName,
            rtspUrl: `rtsp://${serviceIp}:${go2rtcRtspPort}/${go2rtcName}`,
            resolution: undefined as string | undefined,
          };
        });

        const block = buildFrigateCameraBlock(streams, useNodelink);
        frigateConfig.cameras[frigateName] = block;

        if (!useNodelink) {
          for (const s of streams) {
            frigateConfig.go2rtc.streams[s.go2rtcName] = s.rtspUrl;
          }
        }
      }

      // Serialize back to YAML and save
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
});
