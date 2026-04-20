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
        go2rtc: z
          .object({
            enabled: z.boolean().optional(),
            binaryPath: z.string().optional(),
            apiPort: z.number().int().min(1).max(65535).optional(),
            rtspPort: z.number().int().min(1).max(65535).optional(),
            webrtcPort: z.number().int().min(1).max(65535).optional(),
            iceServers: z.array(z.string()).optional(),
          })
          .optional(),
        restreamer: z.enum(["go2rtc", "local"]).optional(),
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

      if (input.go2rtc) {
        patch.go2rtc = { ...current.go2rtc, ...input.go2rtc };
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
   * The Node process exits cleanly after a short grace period so the HTTP
   * response lands before the socket closes. An external supervisor
   * (systemd / docker / pm2) must be configured to restart the process.
   *
   * Used by the Settings UI after save when a setting that requires a
   * backend reboot (currently: `restreamer`) has changed.
   */
  restart: adminProcedure
    .meta({ description: "Restart the Node process (supervisor must bring it back up)" })
    .mutation(() => {
      // Give the response a beat to flush back to the client, then exit.
      // The shutdown handler registered on SIGTERM runs automatically.
      setTimeout(() => {
        process.kill(process.pid, "SIGTERM");
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
