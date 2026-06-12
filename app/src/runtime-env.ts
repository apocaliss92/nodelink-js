import { existsSync } from "node:fs";

/**
 * Runtime environment detection.
 *
 * The official Docker image sets `NODELINK_DOCKER=1` (see Dockerfile). As a
 * fallback we also probe for `/.dockerenv`, which is present in virtually every
 * container runtime, so manually-built or third-party images are still detected.
 */

let cachedIsDocker: boolean | undefined;

/** True when the Manager runs inside a container (official Docker image or any). */
export function isDockerRuntime(): boolean {
  if (cachedIsDocker === undefined) {
    cachedIsDocker =
      process.env.NODELINK_DOCKER === "1" || existsSync("/.dockerenv");
  }
  return cachedIsDocker;
}

/**
 * Whether the in-app packet Capture feature (live tshark capture) is offered.
 *
 * Capture is intentionally limited to local / bare-metal installs: under Docker
 * it needs host networking plus elevated capabilities to see real camera
 * traffic, so the tab is hidden and the API rejects start requests there.
 */
export function isCaptureAvailable(): boolean {
  return !isDockerRuntime();
}
