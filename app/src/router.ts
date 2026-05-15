import { router } from "./trpc.js";
import { configRouter } from "./routers/config.js";
import { baichuanRouter } from "./routers/baichuan.js";
import { camerasRouter } from "./routers/cameras.js";
import { rtspRouter } from "./routers/rtsp.js";
import { settingsRouter } from "./routers/settings.js";
import { logsRouter } from "./routers/logs.js";
import { eventsRouter } from "./routers/events.js";
import { go2rtcRouter } from "./routers/go2rtc.js";
import { frigateRouter } from "./routers/frigate.js";
import { diagnosticsRouter } from "./routers/diagnostics.js";
import { webrtcRouter } from "./routers/webrtc.js";
export const appRouter = router({
  config: configRouter,
  baichuan: baichuanRouter,
  cameras: camerasRouter,
  rtsp: rtspRouter,
  settings: settingsRouter,
  logs: logsRouter,
  events: eventsRouter,
  go2rtc: go2rtcRouter,
  frigate: frigateRouter,
  diagnostics: diagnosticsRouter,
  webrtc: webrtcRouter,
});

export type AppRouter = typeof appRouter;
