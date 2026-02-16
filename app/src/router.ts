import { router } from "./trpc.js";
import { configRouter } from "./routers/config.js";
import { baichuanRouter } from "./routers/baichuan.js";
import { camerasRouter } from "./routers/cameras.js";
import { rtspRouter } from "./routers/rtsp.js";
import { rtspProxyRouter } from "./routers/rtsp-proxy.js";
import { settingsRouter } from "./routers/settings.js";
import { logsRouter } from "./routers/logs.js";
import { eventsRouter } from "./routers/events.js";
export const appRouter = router({
  config: configRouter,
  baichuan: baichuanRouter,
  cameras: camerasRouter,
  rtsp: rtspRouter,
  rtspProxy: rtspProxyRouter,
  settings: settingsRouter,
  logs: logsRouter,
  events: eventsRouter,
});

export type AppRouter = typeof appRouter;
