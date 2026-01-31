import { adminProcedure, router, publicProcedure } from "../trpc.js";
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
import path from "node:path";
import fs from "node:fs";

function readAppVersion(): string | null {
  if (process.env.APP_VERSION && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }

  const candidates = [
    path.resolve(process.cwd(), "package.json"),
    path.resolve(process.cwd(), "app/package.json"),
    path.resolve(process.cwd(), "../package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (
        parsed?.name === "nodelink-manager" &&
        typeof parsed.version === "string"
      ) {
        return parsed.version;
      }
    } catch {
      // ignore
    }
  }

  // Fallback: return any version we can find.
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as { version?: string };
      if (typeof parsed.version === "string") return parsed.version;
    } catch {
      // ignore
    }
  }

  return null;
}

export const settingsRouter = router({
  // Get current settings
  get: publicProcedure
    .meta({ description: "Get current application settings" })
    .query(() => {
      const settings = getSettings();

      // Never expose authTokens.
      const { authTokens: _authTokens, ...rest } = settings;

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
      return {
        httpPort: Number(process.env.PORT) || 3000,
        rtspPort: Number(process.env.RTSP_PORT) || 8554,
        dataPath: path.resolve(dataDir),
        appVersion: readAppVersion(),
      };
    }),

  // Update settings
  update: publicProcedure
    .meta({ description: "Update application settings" })
    .input(
      z.object({
        serviceIp: z.string().optional(),
        hostPort: z.number().int().min(1).max(65535).optional(),
        logLevel: z.enum(["error", "warn", "info", "debug"]).optional(),
        logRetentionDays: z.number().optional(),
        rtspRequireAuth: z.boolean().optional(),
        // Paths are controlled by DATA_PATH env var, not configurable at runtime
      }),
    )
    .mutation(({ input }) => {
      const settings = saveSettings(input);
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

      const { authTokens: _authTokens, ...rest } = settings;
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

  // Reset settings to defaults
  reset: publicProcedure
    .meta({ description: "Reset settings to defaults" })
    .mutation(() => {
      const defaults = SettingsSchema.parse({});
      saveSettings(defaults);
      reloadLogger();
      const { authTokens: _authTokens, ...rest } = defaults;
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
