export type RtspStreamProfile = "main" | "sub";

export function buildRtspPath(channel: number, stream: RtspStreamProfile): string {
  // Standard Reolink path:
  // - channel is 0-based in most APIs, but RTSP path is 1-based and 2-digit.
  const ch = String(channel + 1).padStart(2, "0");
  const suffix = stream === "main" ? "main" : "sub";
  return `/h264Preview_${ch}_${suffix}`;
}

export function buildRtspUrl(params: {
  host: string;
  port?: number;
  username: string;
  password: string;
  channel: number;
  stream: RtspStreamProfile;
}): string {
  const port = params.port ?? 554;
  const path = buildRtspPath(params.channel, params.stream);
  const user = encodeURIComponent(params.username);
  const pass = encodeURIComponent(params.password);
  return `rtsp://${user}:${pass}@${params.host}:${port}${path}`;
}

