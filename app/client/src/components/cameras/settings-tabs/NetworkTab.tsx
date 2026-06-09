import { useCallback, useEffect, useState } from "react";
import {
  Section,
  FieldGrid,
  Field,
  Toggle,
  NumberInput,
  ApplyBar,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Network tab.
 *
 * The camera returns six service-port blocks (cmd_id=37) — Server
 * (Baichuan protocol on TCP 9000), HTTP, HTTPS, RTSP, RTMP, ONVIF —
 * each with its own port number and enable flag. We surface every
 * one with a port input + enable toggle and ship the dirty fields
 * in a single `setNetPort` call (cmd_id=36).
 *
 * IP / DNS / Wi-Fi remain read-only — those are listed below the
 * port editor for reference but the manager intentionally doesn't
 * let you change them from the same connection you're using.
 */
type PortKey = "server" | "http" | "https" | "rtsp" | "rtmp" | "onvif";

interface PortRow {
  key: PortKey;
  label: string;
  hint: string;
}

const PORTS: PortRow[] = [
  { key: "server", label: "Server (Baichuan)", hint: "TCP 9000 — this is the port the manager itself uses; turn off only if you know what you're doing." },
  { key: "http",   label: "HTTP",              hint: "Web UI / CGI API." },
  { key: "https",  label: "HTTPS",             hint: "Encrypted web UI / CGI." },
  { key: "rtsp",   label: "RTSP",              hint: "What ffmpeg / Frigate ingest from." },
  { key: "rtmp",   label: "RTMP",              hint: "Legacy stream protocol, mostly unused." },
  { key: "onvif",  label: "ONVIF",             hint: "Needed by some NVRs and third-party tools." },
];

interface PortValue {
  port: number | undefined;
  enable: boolean;
}

type Form = Record<PortKey, PortValue>;

interface PortBlock {
  enable?: number | string;
  // The XML tag has lowercase port keys: serverPort, httpPort, httpsPort,
  // rtspPort, rtmpPort, onvifPort. After parseXmlFragmentToJson the keys
  // stay as-is.
  serverport?: number | string;
  httpport?: number | string;
  httpsport?: number | string;
  rtspport?: number | string;
  rtmpport?: number | string;
  onvifport?: number | string;
  [k: string]: unknown;
}

interface PortsResponse {
  server?: PortBlock;
  http?: PortBlock;
  https?: PortBlock;
  rtsp?: PortBlock;
  rtmp?: PortBlock;
  onvif?: PortBlock;
  [k: string]: unknown;
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function readPortsForm(raw: PortsResponse | null): Form {
  // For each port, pluck `<xxxPort>` and `<enable>`. The library lowercases
  // XML tags on parse, so the inner port field is `serverport`, `httpport`,
  // `httpsport`, `rtspport`, `rtmpport`, `onvifport`.
  const blank: PortValue = { port: undefined, enable: false };
  const out: Form = {
    server: { ...blank },
    http: { ...blank },
    https: { ...blank },
    rtsp: { ...blank },
    rtmp: { ...blank },
    onvif: { ...blank },
  };
  if (!raw || typeof raw !== "object") return out;
  for (const key of Object.keys(out) as PortKey[]) {
    const block = raw[key] as PortBlock | undefined;
    if (!block) continue;
    const portField = `${key}port` as keyof PortBlock;
    out[key] = {
      port: toNumber(block[portField]),
      enable: toNumber(block.enable) === 1,
    };
  }
  return out;
}

export function NetworkTab({ cameraId, channel }: TabProps) {
  const [network, setNetwork] = useState<unknown>(null);
  const [wifi, setWifi] = useState<unknown>(null);
  const [wifiSignal, setWifiSignal] = useState<unknown>(null);
  const [portsForm, setPortsForm] = useState<Form | null>(null);
  const [loadedPorts, setLoadedPorts] = useState<Form | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const fail = (k: string) => (e: unknown) =>
      setErrs((prev) => ({
        ...prev,
        [k]: e instanceof Error ? e.message : String(e),
      }));
    void trpcQuery("baichuan.getNetworkInfo", { cameraId })
      .then(setNetwork)
      .catch(fail("network"));
    void trpcQuery<PortsResponse>("baichuan.getPorts", { cameraId })
      .then((p) => {
        const form = readPortsForm(p);
        setPortsForm(form);
        setLoadedPorts(form);
        setSaved(false);
      })
      .catch(fail("ports"));
    void trpcQuery("baichuan.getWifi", { cameraId, channel })
      .then(setWifi)
      .catch(fail("wifi"));
    void trpcQuery("baichuan.getWifiSignal", { cameraId, channel })
      .then(setWifiSignal)
      .catch(fail("wifiSignal"));
  }, [cameraId, channel]);

  useEffect(refresh, [refresh]);

  const dirty = JSON.stringify(loadedPorts) !== JSON.stringify(portsForm);

  const apply = useCallback(async () => {
    if (!portsForm || !loadedPorts) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      // Only send blocks where SOMETHING changed (port number or enable
      // flag), and only the fields that changed inside each block.
      const patch: Record<PortKey, { port?: number; enable?: boolean }> = {} as never;
      for (const key of Object.keys(portsForm) as PortKey[]) {
        const cur = portsForm[key];
        const old = loadedPorts[key];
        const block: { port?: number; enable?: boolean } = {};
        if (cur.port !== undefined && cur.port !== old.port) {
          block.port = cur.port;
        }
        if (cur.enable !== old.enable) {
          block.enable = cur.enable;
        }
        if (block.port !== undefined || block.enable !== undefined) {
          patch[key] = block;
        }
      }
      if (Object.keys(patch).length > 0) {
        await trpcMutation("baichuan.setNetPort", {
          cameraId,
          ...patch,
        });
      }
      setSaved(true);
      refresh();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [portsForm, loadedPorts, cameraId, refresh]);

  return (
    <div>
      <Section
        title="Service ports"
        description="Each protocol has its own port and enable flag. Most users only need to touch RTSP / ONVIF; changing the Baichuan Server port disconnects the manager."
      >
        {portsForm === null ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            {errs.ports ?? "Loading…"}
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {PORTS.map((row) => {
              const cur = portsForm[row.key];
              return (
                <div
                  key={row.key}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] p-3"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <div className="text-[12px] font-semibold text-[var(--color-foreground)]">
                        {row.label}
                      </div>
                      <div className="text-[10px] text-[var(--color-foreground-muted)]">
                        {row.hint}
                      </div>
                    </div>
                  </div>
                  <FieldGrid>
                    <Field label="Port" hint="1–65535">
                      <NumberInput
                        value={cur.port}
                        min={1}
                        max={65535}
                        onChange={(v) =>
                          setPortsForm((prev) =>
                            prev
                              ? { ...prev, [row.key]: { ...prev[row.key], port: v } }
                              : prev,
                          )
                        }
                        disabled={saving}
                      />
                    </Field>
                    <Field label="Enabled">
                      <Toggle
                        value={cur.enable}
                        onChange={(v) =>
                          setPortsForm((prev) =>
                            prev
                              ? { ...prev, [row.key]: { ...prev[row.key], enable: v } }
                              : prev,
                          )
                        }
                        disabled={saving}
                      />
                    </Field>
                  </FieldGrid>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      <Section
        title="Network"
        description="IP / netmask / gateway / DNS / MAC as reported by getNetworkInfo (cmd_id=78). Read-only — changing IPs from this dashboard would knock the camera off the network you're using to talk to it."
      >
        <Json value={network} error={errs.network} />
      </Section>

      <Section
        title="Wi-Fi"
        description="Connection details for wireless models. Missing fields = wired camera."
      >
        <Json value={wifi} error={errs.wifi} />
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)] mb-1">
            Signal strength
          </div>
          <Json value={wifiSignal} error={errs.wifiSignal} />
        </div>
      </Section>

      <ApplyBar
        dirty={dirty}
        saving={saving}
        saved={saved}
        error={saveError}
        onApply={() => void apply()}
        onRevert={() => setPortsForm(loadedPorts)}
        onRefresh={refresh}
      />
    </div>
  );
}

function Json({ value, error }: { value: unknown; error?: string }) {
  if (error) {
    return <div className="text-[11px] text-[var(--color-foreground-muted)]">{error}</div>;
  }
  if (value === null) {
    return <div className="text-[11px] text-[var(--color-foreground-muted)]">Loading…</div>;
  }
  return (
    <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[240px]">
{JSON.stringify(value, null, 2)}
    </pre>
  );
}
