import { useEffect, useState } from "react";
import { Section, type TabProps } from "./shared";
import { trpcQuery } from "../../../api";

/**
 * Read-only network view. Reolink exposes a `getNetworkInfo` block with
 * IP / netmask / gateway / MAC and a `getPorts` block listing every
 * service the camera serves (RTSP, RTMP, ONVIF, HTTP, HTTPS, etc). The
 * library has a `setNetPort` setter for individual ports but we keep
 * port editing out of the manager UI for now — it's an easy footgun on
 * a camera you're connecting to over those same ports.
 */
export function NetworkTab({ cameraId, channel }: TabProps) {
  const [network, setNetwork] = useState<unknown>(null);
  const [wifi, setWifi] = useState<unknown>(null);
  const [wifiSignal, setWifiSignal] = useState<unknown>(null);
  const [ports, setPorts] = useState<unknown>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});

  useEffect(() => {
    const fail = (k: string) => (e: unknown) =>
      setErrs((prev) => ({
        ...prev,
        [k]: e instanceof Error ? e.message : String(e),
      }));
    void trpcQuery("baichuan.getNetworkInfo", { cameraId }).then(setNetwork).catch(fail("network"));
    void trpcQuery("baichuan.getPorts", { cameraId }).then(setPorts).catch(fail("ports"));
    void trpcQuery("baichuan.getWifi", { cameraId, channel }).then(setWifi).catch(fail("wifi"));
    void trpcQuery("baichuan.getWifiSignal", { cameraId, channel }).then(setWifiSignal).catch(fail("wifiSignal"));
  }, [cameraId, channel]);

  return (
    <div>
      <Section title="Network" description="IP / netmask / gateway / DNS / MAC as reported by getNetworkInfo (cmd_id=78).">
        <Json value={network} error={errs.network} />
      </Section>

      <Section title="Ports" description="Open services on the camera — RTSP, RTMP, ONVIF, HTTP, HTTPS. Read-only here; use the Reolink app to change them.">
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
