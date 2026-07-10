/**
 * Process-wide resource diagnostics.
 *
 * Periodically logs the live handle/request counts, a per-type handle
 * breakdown, memory usage and the email-push SMTP status. This exists to
 * confirm (or rule out) the "SMTP dies after a few days" hypothesis: if the
 * intake wedges while the process stays alive, a monotonic climb in
 * `handles` / socket count over days points at a process-wide file-descriptor
 * leak (BCUDP/RTSP sleep-wake churn) rather than a bug inside the SMTP module.
 *
 * `_getActiveHandles` / `_getActiveRequests` are undocumented Node internals;
 * they are accessed defensively so a future runtime that drops them degrades
 * to a memory-only line instead of throwing.
 */

import { appLogger } from "./logger.js";
import { getEmailPushServerStatus } from "./email-push-server.js";

let timer: ReturnType<typeof setInterval> | null = null;

function countHandleTypes(handles: unknown[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const h of handles) {
    const name =
      (h as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";
    out[name] = (out[name] ?? 0) + 1;
  }
  return out;
}

export function startProcessDiagnostics(intervalMs = 60_000): void {
  if (timer) return;
  const proc = process as unknown as {
    _getActiveHandles?: () => unknown[];
    _getActiveRequests?: () => unknown[];
  };
  const mb = (n: number) => Math.round(n / 1024 / 1024);

  const sample = () => {
    try {
      const handles = proc._getActiveHandles?.() ?? [];
      const requests = proc._getActiveRequests?.() ?? [];
      const mem = process.memoryUsage();
      const smtp = getEmailPushServerStatus();
      appLogger.info(
        `handles=${handles.length} requests=${requests.length} ` +
          `rss=${mb(mem.rss)}MB heapUsed=${mb(mem.heapUsed)}MB external=${mb(mem.external)}MB ` +
          `smtp{running=${smtp.running} accepted=${smtp.messagesAccepted} rejected=${smtp.messagesRejected}} ` +
          `byType=${JSON.stringify(countHandleTypes(handles))}`,
        { source: "diagnostics" },
      );
    } catch (err) {
      appLogger.warn(
        `process diagnostics sample failed: ${(err as Error).message}`,
        { source: "diagnostics" },
      );
    }
  };

  timer = setInterval(sample, intervalMs);
  timer.unref?.();
  appLogger.info(
    `Process diagnostics started (every ${Math.round(intervalMs / 1000)}s)`,
    { source: "diagnostics" },
  );
  // Emit an immediate baseline so the first data point isn't intervalMs away.
  sample();
}

export function stopProcessDiagnostics(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
