import { router, publicProcedure } from "../trpc.js";
import { z } from "zod";
import { getRecentEvents } from "../events-manager.js";

export const eventsRouter = router({
  getRecent: publicProcedure
    .meta({ description: "Get recent camera events" })
    .input(
      z
        .object({
          cameraId: z.string().optional(),
        })
        .optional(),
    )
    .query(({ input }) => {
      return getRecentEvents(input?.cameraId);
    }),
});
