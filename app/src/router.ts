import { router } from "./trpc.js";
import { configRouter } from "./routers/config.js";
import { baichuanRouter } from "./routers/baichuan.js";
import { camerasRouter } from "./routers/cameras.js";
import { rtspRouter } from "./routers/rtsp.js";
import { settingsRouter } from "./routers/settings.js";
import { logsRouter } from "./routers/logs.js";
import { eventsRouter } from "./routers/events.js";
import { frigateRouter } from "./routers/frigate.js";
import { diagnosticsRouter } from "./routers/diagnostics.js";
import { webrtcRouter } from "./routers/webrtc.js";
import { captureRouter } from "./routers/capture.js";
import { emailPushRouter } from "./routers/email-push.js";
import { talkRouter } from "./routers/talk.js";
export const appRouter = router({
  capture: captureRouter,
  config: configRouter,
  baichuan: baichuanRouter,
  cameras: camerasRouter,
  rtsp: rtspRouter,
  settings: settingsRouter,
  logs: logsRouter,
  events: eventsRouter,
  frigate: frigateRouter,
  diagnostics: diagnosticsRouter,
  webrtc: webrtcRouter,
  emailPush: emailPushRouter,
  talk: talkRouter,
});

export type AppRouter = typeof appRouter;
