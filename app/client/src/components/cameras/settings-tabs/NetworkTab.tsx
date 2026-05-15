import { useCallback, useEffect, useState } from "react";
import {
  Section,
  FieldGrid,
  Field,
  Toggle,
  ApplyBar,
  findNumber,
  type TabProps,
} from "./shared";
import { trpcQuery, trpcMutation } from "../../../api";

/**
 * Network tab.
 *
 * Read-only sections for IP / Wi-Fi (changing those over the same camera
 * connection you're using is a footgun). Editable section for serving
 * ports — RTSP / RTMP / ONVIF — via `setNetPort` which uses
 * setPortEnabled under the hood. IP / DNS / gateway are intentionally
 * not editable.
 */
interface PortsForm {
  rtspEnabled: boolean;
  rtmpEnabled: boolean;
  onvifEnabled: boolean;
}

function readPortsForm(ports: unknown): PortsForm {
  return {
    rtspEnabled: findNumber(ports, "rtspEnable") === 1,
    rtmpEnabled: findNumber(ports, "rtmpEnable") === 1,
    onvifEnabled: findNumber(ports, "onvifEnable") === 1,
  };
}

export function NetworkTab({ cameraId, channel }: TabProps) {
  const [network, setNetwork] = useState<unknown>(null);
  const [wifi, setWifi] = useState<unknown>(null);
  const [wifiSignal, setWifiSignal] = useState<unknown>(null);
  const [ports, setPorts] = useState<unknown>(null);
  const [portsForm, setPortsForm] = useState<PortsForm | null>(null);
  const [loadedPorts, setLoadedPorts] = useState<PortsForm | null>(null);
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
    void trpcQuery("baichuan.getPorts", { cameraId })
      .then((p) => {
        setPorts(p);
        const form = readPortsForm(p);
        setPortsForm(form);
        setLoadedPorts(form);
        setSaved(false);
      })
      .catch(fail("ports"));
    void trpcQuery("baichuan.getWifi", { cameraId, channel }).then(setWifi).catch(fail("wifi"));
    void trpcQuery("baichuan.getWifiSignal", { cameraId, channel }).then(setWifiSignal).catch(fail("wifiSignal"));
  }, [cameraId, channel]);

  useEffect(refresh, [refresh]);

  const dirty = JSON.stringify(loadedPorts) !== JSON.stringify(portsForm);

  const apply = useCallback(async () => {
    if (!portsForm || !loadedPorts) return;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const patch: Record<string, 0 | 1> = {};
      if (portsForm.rtspEnabled !== loadedPorts.rtspEnabled) {
        patch.rtspEnable = portsForm.rtspEnabled ? 1 : 0;
      }
      if (portsForm.rtmpEnabled !== loadedPorts.rtmpEnabled) {
        patch.rtmpEnable = portsForm.rtmpEnabled ? 1 : 0;
      }
      if (portsForm.onvifEnabled !== loadedPorts.onvifEnabled) {
        patch.onvifEnable = portsForm.onvifEnabled ? 1 : 0;
      }
      await trpcMutation("baichuan.setNetPort", { cameraId, ...patch });
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
        description="Toggle the protocols the camera serves. RTSP is what go2rtc and the manager's local restreamer ingest from."
      >
        {portsForm === null ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)] py-2">
            {errs.ports ?? "Loading…"}
          </div>
        ) : (
          <FieldGrid>
            <Field label="RTSP" hint="default port 554 — used by ffmpeg / go2rtc">
              <Toggle
                value={portsForm.rtspEnabled}
                onChange={(v) =>
                  setPortsForm((prev) => (prev ? { ...prev, rtspEnabled: v } : prev))
                }
                disabled={saving}
              />
            </Field>
            <Field label="RTMP" hint="legacy stream protocol, mostly unused now">
              <Toggle
                value={portsForm.rtmpEnabled}
                onChange={(v) =>
                  setPortsForm((prev) => (prev ? { ...prev, rtmpEnabled: v } : prev))
                }
                disabled={saving}
              />
            </Field>
            <Field label="ONVIF" hint="needed by some NVRs and third-party tools">
              <Toggle
                value={portsForm.onvifEnabled}
                onChange={(v) =>
                  setPortsForm((prev) => (prev ? { ...prev, onvifEnabled: v } : prev))
                }
                disabled={saving}
              />
            </Field>
          </FieldGrid>
        )}
      </Section>

      <Section title="Network" description="IP / netmask / gateway / DNS / MAC as reported by getNetworkInfo (cmd_id=78). Read-only — changing IPs from this dashboard would knock the camera off the network you're using to talk to it.">
        <Json value={network} error={errs.network} />
      </Section>

      <Section title="All ports" description="Raw cmd_id=37 response showing every served port (server/HTTPS/ONVIF/RTSP/RTMP). Use the toggles above to change the common ones.">
        <Json value={ports} error={errs.ports} />
      </Section>

      <Section title="Wi-Fi" description="Connection details for wireless models. Missing fields = wired camera.">
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
