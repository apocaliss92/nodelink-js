import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import {
  getSettings,
  saveSettings,
  SettingsSchema,
  getRtspCredentials,
  addRtspCredential,
  updateRtspCredential,
  deleteRtspCredential,
} from "../settings-store.js";
import { reloadLogger } from "../logger.js";
import { updateRtspUrls } from "../rtsp-manager.js";
import path from "node:path";
import fs from "node:fs";

export const settingsRouter = router({
  // Get current settings
  get: publicProcedure
    .meta({ description: "Get current application settings" })
    .query(() => {
      return getSettings();
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
        rtspDefaultPort: z.number().optional(),
        rtspRequireAuth: z.boolean().optional(),
        // Paths are controlled by DATA_PATH env var, not configurable at runtime
      }),
    )
    .mutation(({ input }) => {
      const settings = saveSettings(input);
      // Reload logger if log settings changed
      if (input.logLevel) {
        reloadLogger();
      }
      // Update RTSP URLs if serviceIp or auth changed
      if (
        input.serviceIp !== undefined ||
        input.rtspRequireAuth !== undefined
      ) {
        updateRtspUrls();
      }
      return settings;
    }),

  // Reset settings to defaults
  reset: publicProcedure
    .meta({ description: "Reset settings to defaults" })
    .mutation(() => {
      const defaults = SettingsSchema.parse({});
      saveSettings(defaults);
      reloadLogger();
      return defaults;
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

  // --- RTSP Credentials Management ---

  // List all RTSP credentials
  listCredentials: publicProcedure
    .meta({ description: "List all RTSP credentials (passwords hidden)" })
    .query(() => {
      const credentials = getRtspCredentials();
      // Hide passwords in the response
      return credentials.map((c) => ({
        ...c,
        password: "********",
      }));
    }),

  // Get credential by ID (with password)
  getCredential: publicProcedure
    .meta({ description: "Get RTSP credential by ID (includes password)" })
    .input(z.object({ id: z.string() }))
    .query(({ input }) => {
      const credentials = getRtspCredentials();
      return credentials.find((c) => c.id === input.id) ?? null;
    }),

  // Add new RTSP credential
  addCredential: publicProcedure
    .meta({ description: "Add a new RTSP credential" })
    .input(
      z.object({
        username: z.string().min(1),
        password: z.string().min(1),
        description: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      return addRtspCredential(input);
    }),

  // Update RTSP credential
  updateCredential: publicProcedure
    .meta({ description: "Update an existing RTSP credential" })
    .input(
      z.object({
        id: z.string(),
        username: z.string().min(1).optional(),
        password: z.string().min(1).optional(),
        description: z.string().optional(),
      }),
    )
    .mutation(({ input }) => {
      const { id, ...updates } = input;
      const result = updateRtspCredential(id, updates);
      if (!result) {
        throw new Error(`Credential not found: ${id}`);
      }
      return result;
    }),

  // Delete RTSP credential
  deleteCredential: publicProcedure
    .meta({ description: "Delete an RTSP credential" })
    .input(z.object({ id: z.string() }))
    .mutation(({ input }) => {
      const result = deleteRtspCredential(input.id);
      if (!result) {
        throw new Error(`Credential not found: ${input.id}`);
      }
      return { success: true };
    }),
});
