import {
  adminProcedure,
  protectedProcedure,
  router,
  publicProcedure,
} from "../trpc.js";
import { z } from "zod";
import {
  getSettings,
  saveSettings,
  SettingsSchema,
  addDashboardUser,
  deleteDashboardUser,
  listDashboardUsers,
  setDashboardUserPassword,
} from "../settings-store.js";
import { reloadLogger } from "../logger.js";
import { updateRtspUrls } from "../rtsp-manager.js";
import {
  connectMqtt,
  disconnectMqtt,
} from "../events-manager.js";
import { updateHomeAssistantPolling } from "../homeassistant-mqtt.js";
import path from "node:path";
import fs from "node:fs";
import { createSourceLogger } from "../logger.js";
import { inferGithubRepoSlug } from "../github-utils.js";
import { readAppVersion } from "../app-version.js";

export const settingsRouter = router({
  // Get current settings
  get: protectedProcedure
    .meta({ description: "Get current application settings" })
    .query(() => {
      const settings = getSettings();

      // Never expose authTokens / personalTokens.
      const {
        authTokens: _authTokens,
        personalTokens: _personalTokens,
        ...rest
      } = settings;

      return {
        ...rest,
        dashboardUsers: settings.dashboardUsers.map(
          ({ username, role, createdAt, updatedAt }) => ({
            username,
            role,
            createdAt,
            updatedAt,
          }),
        ),
      };
    }),

  // Runtime info (read-only)
  getRuntime: publicProcedure
    .meta({ description: "Get runtime information (ports, env-derived paths)" })
    .query(() => {
      const dataDir = process.env.DATA_PATH || ".";
      const repo = inferGithubRepoSlug();
      const docsUrl = repo
        ? `https://github.com/${repo}/blob/main/documentation/manager-api.md`
        : null;
      return {
        httpPort: Number(process.env.PORT) || 3000,
        rtspPort: Number(process.env.RTSP_PORT) || 8554,
        dataPath: path.resolve(dataDir),
        appVersion: readAppVersion(),
        docsUrl,
      };
    }),

  // Update settings
  update: adminProcedure
    .meta({ description: "Update application settings" })
    .input(
      z.object({
        serviceIp: z.string().optional(),
        hostPort: z.number().int().min(1).max(65535).optional(),
        logLevel: z.enum(["error", "warn", "info", "debug"]).optional(),
        logRetentionDays: z.number().optional(),
        rtspRequireAuth: z.boolean().optional(),
        auth: z
          .object({
            trustedProxy: z
              .object({
                enabled: z.boolean().optional(),
                allowedIps: z.array(z.string().min(1)).optional(),
                usernameHeader: z.string().optional(),
                groupsHeader: z.string().optional(),
                adminGroup: z.string().optional(),
              })
              .optional(),
          })
          .optional(),
        webrtc: z
          .object({
            icePortRange: z.string().optional(),
            iceAdditionalHostAddresses: z.string().optional(),
          })
          .optional(),
        mqtt: z
          .object({
            enabled: z.boolean().optional(),
            brokerUrl: z.string().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
            clientId: z.string().optional(),
            topicPrefix: z.string().optional(),
            qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
            reconnectPeriod: z.number().optional(),
          })
          .optional(),
        homeassistant: z
          .object({
            enabled: z.boolean().optional(),
            discoveryPrefix: z.string().optional(),
            pollIntervalSeconds: z.number().min(10).max(3600).optional(),
            stateTopicPrefix: z.string().optional(),
          })
          .optional(),
        localRtsp: z
          .object({
            port: z.number().int().min(1).max(65535).optional(),
            bindHost: z.string().optional(),
            requireAuth: z.boolean().optional(),
          })
          .optional(),
        frigate: z
          .object({
            host: z.string().optional(),
            username: z.string().optional(),
            password: z.string().optional(),
            streamMode: z.enum(["nodelink", "frigate"]).optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ input }) => {
      const current = getSettings();
      const patch: any = { ...input };

      if (input.auth) {
        patch.auth = {
          ...current.auth,
          ...input.auth,
          trustedProxy: input.auth.trustedProxy
            ? { ...current.auth.trustedProxy, ...input.auth.trustedProxy }
            : current.auth.trustedProxy,
        };
      }

      if (input.webrtc) {
        patch.webrtc = { ...current.webrtc, ...input.webrtc };
      }

      if (input.mqtt) {
        patch.mqtt = { ...current.mqtt, ...input.mqtt };
        void disconnectMqtt().then(() => connectMqtt());
      }

      if (input.homeassistant) {
        patch.homeassistant = {
          ...current.homeassistant,
          ...input.homeassistant,
        };
        updateHomeAssistantPolling();
      }

      if (input.localRtsp) {
        patch.localRtsp = { ...current.localRtsp, ...input.localRtsp };
      }

      if (input.frigate) {
        patch.frigate = { ...current.frigate, ...input.frigate };
      }

      const settings = saveSettings(patch);
      // Reload logger if log settings changed
      if (
        input.logLevel !== undefined ||
        input.logRetentionDays !== undefined
      ) {
        reloadLogger();
      }
      // Update RTSP URLs if serviceIp or auth changed
      if (
        input.serviceIp !== undefined ||
        input.rtspRequireAuth !== undefined
      ) {
        updateRtspUrls();
      }

      const {
        authTokens: _authTokens,
        personalTokens: _personalTokens,
        ...rest
      } = settings;
      return {
        ...rest,
        dashboardUsers: settings.dashboardUsers.map(
          ({ username, role, createdAt, updatedAt }) => ({
            username,
            role,
            createdAt,
            updatedAt,
          }),
        ),
      };
    }),

  /**
   * Request a server restart.
   *
   * Works in both modes:
   *   - Dev (`tsx watch`): bump the mtime of the watched entrypoint so tsx
   *     tears down the child process and re-spawns it. Sending SIGTERM to
   *     ourselves would make `tsx watch` exit as well, which is exactly
   *     what "the restart does not work" looks like in dev.
   *   - Production (systemd / docker / pm2): SIGTERM is relayed to the
   *     supervisor, which restarts the process.
   *
   * A hard `process.exit(0)` is scheduled as a last-resort fallback so the
   * process cannot get stuck if a shutdown step hangs (e.g. a camera
   * refusing to close its socket during stopAllRtspServers).
   */
  restart: adminProcedure
    .meta({ description: "Restart the Node process (supervisor / tsx watch must bring it back up)" })
    .mutation(() => {
      const log = createSourceLogger("server");
      log.info("[settings.restart] scheduling restart (300ms)");
      setTimeout(() => {
        // Dev path: update mtime of src/server.ts so `tsx watch` reloads.
        // Falls through silently in production where the file does not exist
        // next to the compiled runtime.
        try {
          const candidate = path.resolve(process.cwd(), "src/server.ts");
          if (fs.existsSync(candidate)) {
            const now = new Date();
            fs.utimesSync(candidate, now, now);
            log.info("[settings.restart] touched src/server.ts for tsx watch");
          }
        } catch (e) {
          log.debug(`[settings.restart] touch failed: ${(e as Error).message}`);
        }

        // Production path: SIGTERM runs the graceful shutdown handler.
        try {
          process.kill(process.pid, "SIGTERM");
          log.info("[settings.restart] SIGTERM sent");
        } catch (e) {
          log.warn(`[settings.restart] SIGTERM failed: ${(e as Error).message}`);
        }

        // Safety net: if shutdown hangs (e.g. hung ffmpeg child during
        // stopAllRtspServers), force-exit after 5s so the supervisor can
        // bring us back up.
        setTimeout(() => {
          log.warn("[settings.restart] shutdown timed out — forcing exit");
          process.exit(0);
        }, 5_000).unref();
      }, 300);
      return { ok: true, restartingInMs: 300 };
    }),

  // Reset settings to defaults
  reset: adminProcedure
    .meta({ description: "Reset settings to defaults" })
    .mutation(() => {
      const defaults = SettingsSchema.parse({});
      saveSettings(defaults);
      reloadLogger();
      const {
        authTokens: _authTokens,
        personalTokens: _personalTokens,
        ...rest
      } = defaults;
      return {
        ...rest,
        dashboardUsers: defaults.dashboardUsers.map(
          ({ username, role, createdAt, updatedAt }) => ({
            username,
            role,
            createdAt,
            updatedAt,
          }),
        ),
      };
    }),

  // Get paths info
  getPaths: publicProcedure
    .meta({ description: "Get resolved paths information" })
    .query(() => {
      const dataDir = process.env.DATA_PATH || ".";
      return {
        dataPath: path.resolve(dataDir),
        logsPath: path.resolve(path.join(dataDir, "logs")),
        settingsPath: path.resolve(path.join(dataDir, "settings.json")),
        cwd: process.cwd(),
      };
    }),

  // Check if paths exist
  checkPaths: publicProcedure
    .meta({ description: "Check if configured paths exist" })
    .query(() => {
      const dataDir = process.env.DATA_PATH || ".";
      return {
        dataExists: fs.existsSync(path.resolve(dataDir)),
        logsExists: fs.existsSync(path.resolve(path.join(dataDir, "logs"))),
        settingsExists: fs.existsSync(
          path.resolve(path.join(dataDir, "settings.json")),
        ),
      };
    }),

  // --- Users Management (admin only) ---

  listDashboardUsers: adminProcedure
    .meta({ description: "List users (admin only)" })
    .query(() => {
      return listDashboardUsers();
    }),

  addDashboardUser: adminProcedure
    .meta({ description: "Add a user (admin only)" })
    .input(
      z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        role: z.enum(["admin", "user"]).optional(),
      }),
    )
    .mutation(({ input }) => {
      return addDashboardUser(input);
    }),

  deleteDashboardUser: adminProcedure
    .meta({ description: "Delete a user (admin only)" })
    .input(z.object({ username: z.string().min(1) }))
    .mutation(({ input }) => {
      const ok = deleteDashboardUser(input.username);
      if (!ok) throw new Error(`User not found: ${input.username}`);
      return { success: true };
    }),

  setDashboardUserPassword: adminProcedure
    .meta({ description: "Set user password (admin only)" })
    .input(
      z.object({ username: z.string().min(1), password: z.string().min(1) }),
    )
    .mutation(({ input }) => {
      const ok = setDashboardUserPassword(input);
      if (!ok) throw new Error(`User not found: ${input.username}`);
      return { success: true };
    }),
});
