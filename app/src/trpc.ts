import { initTRPC, TRPCError } from "@trpc/server";
import type express from "express";
import type { AuthUser } from "./auth.js";
import { getAuthConfig } from "./auth.js";

export type TrpcContext = {
  req: express.Request;
  res: express.Response;
  authUser: AuthUser | null;
};

const t = initTRPC.context<TrpcContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;
export const middleware = t.middleware;

const requireAuth = t.middleware(({ ctx, next }) => {
  if (!getAuthConfig().enabled) return next();
  if (!ctx.authUser) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next();
});

const requireAdmin = t.middleware(({ ctx, next }) => {
  if (!getAuthConfig().enabled) return next();
  if (!ctx.authUser) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  if (ctx.authUser.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next();
});

export const protectedProcedure = t.procedure.use(requireAuth);
export const adminProcedure = t.procedure.use(requireAdmin);
