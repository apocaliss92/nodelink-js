import { router, publicProcedure } from "../trpc.js";
import { getBackchannelStatus } from "../backchannel-manager.js";

/**
 * Read-only router for the RTSP backchannel listener (Frigate 2-way audio).
 * Lifecycle is driven by settings — enable/disable + port live under
 * `settings.talk` and are mutated through `settings.update`.
 */
export const talkRouter = router({
  status: publicProcedure.query(() => getBackchannelStatus()),
});
