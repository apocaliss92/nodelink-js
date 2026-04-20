import { useState } from 'react';
import { Eye, Activity, Link, Copy, Users } from 'lucide-react';
import { trpcMutation } from '../../api';
import type { AvailableStream } from './types';
import { copyToClipboard } from './utils';

interface StreamProfileCardProps {
  cameraId: string;
  stream: AvailableStream;
  rtspServer?: { status?: string; connections?: number; rtspUrl?: string; go2rtcStreamName?: string; mode?: string; port?: number };
  onPreview: () => void;
  streamName: string;
  go2rtcApiPort: number | null;
  go2rtcRtspPort: number | null;
  serviceIp: string;
  isBattery?: boolean;
  /**
   * Restreamer mode from settings. When "local", go2rtc-based previews
   * (WebRTC/HLS/MJPEG/MSE/MP4/snapshot) are hidden — only the RTSP URL
   * remains copyable.
   */
  restreamer?: "go2rtc" | "local";
  /**
   * Default local RTSP port from settings. Used as a fallback for building
   * an RTSP URL in local mode when no per-stream port is known (e.g. an
   * idle stream that hasn't been bound yet at page load).
   */
  localRtspPort?: number | null;
}

export function StreamProfileCard({ cameraId, stream, rtspServer, onPreview, streamName, go2rtcApiPort, go2rtcRtspPort, serviceIp, isBattery, restreamer, localRtspPort }: StreamProfileCardProps) {
  const isActive = rtspServer?.status === 'running';
  // Battery cameras stream on-demand: show preview/URLs even when the native stream
  // is not running (idle). Clicking Preview will wake the camera.
  const showOnDemand = isBattery && !isActive;
  const [diagStatus, setDiagStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [urlsOpen, setUrlsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Resolve effective mode: per-server mode wins (backend truth),
  // fall back to the global settings flag when the server is idle.
  const effectiveMode = rtspServer?.mode === "local" || rtspServer?.mode === "go2rtc"
    ? rtspServer.mode
    : (restreamer ?? "go2rtc");
  const isLocal = effectiveMode === "local";

  const viewers = isActive ? (rtspServer?.connections ?? 0) : 0;
  const go2rtcHost = serviceIp || window.location.hostname;
  // When served over HTTPS (nginx reverse proxy) go2rtc's port is plain HTTP —
  // direct https://host:port requests fail with ERR_SSL_PROTOCOL_ERROR.
  // Route through the Express /go2rtc/* proxy instead so the same-origin HTTPS
  // path is used. On HTTP, hit go2rtc directly.
  const isHttps = window.location.protocol === 'https:';
  // go2rtc-derived URLs are unavailable in local mode — gate the base so
  // every preview/URL button below folds into "hidden" cleanly.
  const go2rtcBase = !isLocal && go2rtcApiPort
    ? (isHttps ? `${window.location.origin}/go2rtc` : `http://${go2rtcHost}:${go2rtcApiPort}`)
    : null;
  const src = encodeURIComponent(streamName);
  const hlsUrl = go2rtcBase ? `${go2rtcBase}/api/stream.m3u8?src=${src}` : '';
  const snapshotUrl = go2rtcBase ? `${go2rtcBase}/api/frame.jpeg?src=${src}` : '';
  const mp4Url = go2rtcBase ? `${go2rtcBase}/api/stream.mp4?src=${src}` : '';
  const mseUrl = go2rtcBase ? `${go2rtcBase}/stream.html?src=${src}&mode=mse` : '';
  // RTSP URL:
  //  - local mode: prefer the per-server rtspUrl; fall back to a deterministic
  //    URL from the known port (per-stream info.port if any, else the
  //    default local RTSP port) so users can copy it even while the
  //    BaichuanRtspServer is idle / not yet bound.
  //  - go2rtc mode: deterministic from the stream name + go2rtc RTSP port
  const localPortForUrl = rtspServer?.port ?? localRtspPort ?? null;
  const rtspUrl = isLocal
    ? rtspServer?.rtspUrl
      || (localPortForUrl
        ? `rtsp://${go2rtcHost}:${localPortForUrl}/${streamName}`
        : '')
    : go2rtcRtspPort
      ? `rtsp://${go2rtcHost}:${go2rtcRtspPort}/${streamName}`
      : rtspServer?.rtspUrl ?? '';
  // Preview-button gating: WebRTC/MSE need go2rtc.
  const hasPreview = !isLocal;

  const startAnalysis = async () => {
    setDiagStatus('running');
    try {
      await trpcMutation('diagnostics.start', {
        cameraId,
        profile: stream.profile,
        channel: stream.channel,
        durationMinutes: 5,
      });
      setDiagStatus('complete');
    } catch {
      setDiagStatus('error');
    }
  };

  return (
    <div className="rounded-md border border-[var(--color-border)] p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium capitalize">{stream.profile} Stream</span>
        <div className="flex items-center gap-1.5">
          {isActive && viewers > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-[var(--color-foreground-subtle)]" title={`${viewers} viewer${viewers > 1 ? 's' : ''}`}>
              <Users size={9} />{viewers}
            </span>
          )}
          <span className={`rounded px-1.5 py-0.5 text-[10px] ${isActive ? 'bg-[var(--color-success)]/15 text-[var(--color-success)]' : 'bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)]'}`}>
            {isActive ? 'active' : 'idle'}
          </span>
        </div>
      </div>
      {stream.resolution && (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          {stream.resolution}{stream.codec ? ` · ${stream.codec}` : ''}
        </div>
      )}
      {!isActive && !isBattery && (
        <div className="text-[10px] text-[var(--color-foreground-muted)] mt-1">
          Stream starts automatically when the camera is connected.
        </div>
      )}
      {showOnDemand && (
        <div className="text-[10px] text-[var(--color-foreground-muted)] mt-1">
          On-demand — clicking Preview will wake the camera.
        </div>
      )}

      <div className="flex flex-wrap gap-1 mt-1.5">
        {/* Preview — requires go2rtc (WebRTC/MSE). Hidden in local mode. */}
        {(isActive || showOnDemand) && hasPreview && (
          <div className="relative">
            <button
              type="button"
              onClick={() => { setPreviewOpen(!previewOpen); setUrlsOpen(false); }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface)] transition-colors"
            >
              <Eye size={10} /> Preview ▾
            </button>
            {previewOpen && (
              <div className="absolute bottom-full left-0 mb-1 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-background-elevated)] shadow-lg py-1 min-w-[160px]">
                <button
                  type="button"
                  onClick={() => { onPreview(); setPreviewOpen(false); }}
                  className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)]"
                >
                  WebRTC Preview
                </button>
                {mseUrl && (
                  <button
                    type="button"
                    onClick={() => { window.open(mseUrl, '_blank'); setPreviewOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)]"
                  >
                    MSE Stream
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* URLs dropdown — RTSP always available; go2rtc URLs when active or battery on-demand */}
        {(rtspUrl || (go2rtcBase && (isActive || showOnDemand))) && (
          <div className="relative">
            <button
              onClick={() => { setUrlsOpen(!urlsOpen); setPreviewOpen(false); }}
              className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface)] transition-colors"
            >
              <Link size={10} /> URLs
            </button>
            {urlsOpen && (
              <div className="absolute bottom-full left-0 mb-1 z-10 rounded-md border border-[var(--color-border)] bg-[var(--color-background-elevated)] shadow-lg py-1 min-w-[160px]">
                {rtspUrl && (
                  <button
                    onClick={() => { void copyToClipboard(rtspUrl); setUrlsOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)] flex items-center gap-1.5"
                  >
                    <Copy size={9} /> Copy RTSP URL
                  </button>
                )}
                {(isActive || showOnDemand) && hlsUrl && (
                  <button
                    onClick={() => { void copyToClipboard(hlsUrl); setUrlsOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)] flex items-center gap-1.5"
                  >
                    <Copy size={9} /> Copy HLS URL
                  </button>
                )}
                {(isActive || showOnDemand) && mp4Url && (
                  <button
                    onClick={() => { void copyToClipboard(mp4Url); setUrlsOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)] flex items-center gap-1.5"
                  >
                    <Copy size={9} /> Copy MP4 URL
                  </button>
                )}
                {(isActive || showOnDemand) && snapshotUrl && (
                  <button
                    onClick={() => { void copyToClipboard(snapshotUrl); setUrlsOpen(false); }}
                    className="w-full text-left px-3 py-1.5 text-[11px] hover:bg-[var(--color-surface-hover)] flex items-center gap-1.5"
                  >
                    <Copy size={9} /> Copy Snapshot URL
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {diagStatus === 'idle' && (
          <button onClick={() => void startAnalysis()} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-surface-hover)] hover:bg-[var(--color-surface)] transition-colors">
            <Activity size={10} /> Analyze
          </button>
        )}
        {diagStatus === 'running' && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-warning)] px-2 py-0.5">
            <Activity size={10} /> Analyzing...
          </span>
        )}
        {diagStatus === 'complete' && (
          <span className="flex items-center gap-1 text-[10px] text-[var(--color-success)] px-2 py-0.5">
            <Activity size={10} /> Done
          </span>
        )}
        {diagStatus === 'error' && (
          <button onClick={() => setDiagStatus('idle')} className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] bg-[var(--color-danger)]/15 text-[var(--color-danger)] hover:bg-[var(--color-danger)]/25 transition-colors">
            <Activity size={10} /> Retry
          </button>
        )}
      </div>
    </div>
  );
}
