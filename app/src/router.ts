import { router } from "./trpc.js";
import { configRouter } from "./routers/config.js";
import { baichuanRouter } from "./routers/baichuan.js";
import { camerasRouter } from "./routers/cameras.js";
import { rtspRouter } from "./routers/rtsp.js";
import { settingsRouter } from "./routers/settings.js";
import { logsRouter } from "./routers/logs.js";

export const appRouter = router({
  config: configRouter,
  baichuan: baichuanRouter,
  cameras: camerasRouter,
  rtsp: rtspRouter,
  settings: settingsRouter,
  logs: logsRouter,
});

export type AppRouter = typeof appRouter;
