import { useEffect, useState } from "react";
import { Section, type TabProps } from "./shared";
import { trpcQuery } from "../../../api";

interface VersionInfo {
  name?: string;
  type?: string;
  serialNumber?: string;
  buildDay?: string;
  hardwareVersion?: string;
  cfgVersion?: string;
  firmwareVersion?: string;
  detail?: string;
  itemNo?: string;
  aiVersion?: string;
}

interface SystemGeneral {
  channel?: number;
  norm?: string;
  language?: string;
  [k: string]: unknown;
}

interface BatteryInfo {
  batteryPercent?: number;
  chargeStatus?: number;
  adapterStatus?: number;
  [k: string]: unknown;
}

/**
 * Read-only system info: version, generic system config, battery.
 * Each subsection is independent so a single failing call doesn't blank
 * the whole tab (some cameras don't expose battery, some don't expose
 * SystemGeneral, etc.).
 */
export function SystemTab({ cameraId, channel }: TabProps) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [system, setSystem] = useState<SystemGeneral | null>(null);
  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const [versionErr, setVersionErr] = useState<string | null>(null);
  const [systemErr, setSystemErr] = useState<string | null>(null);
  const [batteryErr, setBatteryErr] = useState<string | null>(null);

  useEffect(() => {
    void trpcQuery<VersionInfo>("baichuan.getVersionInfo", { cameraId })
      .then(setVersion)
      .catch((e) => setVersionErr(e instanceof Error ? e.message : String(e)));
    void trpcQuery<SystemGeneral>("baichuan.getSystemGeneral", { cameraId, channel })
      .then(setSystem)
      .catch((e) => setSystemErr(e instanceof Error ? e.message : String(e)));
    void trpcQuery<BatteryInfo>("baichuan.getBatteryInfo", { cameraId, channel })
      .then(setBattery)
      .catch((e) => setBatteryErr(e instanceof Error ? e.message : String(e)));
  }, [cameraId, channel]);

  return (
    <div>
      <Section
        title="Device"
        description="Camera identification — model, firmware, serial. Equivalent to 'About this device' in the Reolink mobile app."
      >
        {versionErr ? (
          <div className="text-[11px] text-red-300">{versionErr}</div>
        ) : !version ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">Loading…</div>
        ) : (
          <Grid>
            <KV label="Name" value={version.name} />
            <KV label="Model" value={version.type} />
            <KV label="Item no." value={version.itemNo} />
            <KV label="Serial number" value={version.serialNumber} />
            <KV label="Firmware" value={version.firmwareVersion} />
            <KV label="Build" value={version.buildDay} />
            <KV label="Hardware" value={version.hardwareVersion} />
            <KV label="Config schema" value={version.cfgVersion} />
            <KV label="AI bundle" value={version.aiVersion} />
            <KV label="Detail" value={version.detail} />
          </Grid>
        )}
      </Section>

      <Section
        title="Locale & time"
        description="System-general block — what the camera uses for the OSD clock and recording filenames."
      >
        {systemErr ? (
          <div className="text-[11px] text-red-300">{systemErr}</div>
        ) : !system ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">Loading…</div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[160px]">
{JSON.stringify(system, null, 2)}
          </pre>
        )}
      </Section>

      <Section
        title="Battery"
        description="Battery cameras only — wired models will surface an error here."
      >
        {batteryErr ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Not a battery camera ({batteryErr}).
          </div>
        ) : !battery ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">Loading…</div>
        ) : (
          <Grid>
            <KV
              label="Charge"
              value={
                battery.batteryPercent !== undefined
                  ? `${battery.batteryPercent}%`
                  : undefined
              }
            />
            <KV label="Charge status" value={battery.chargeStatus?.toString()} />
            <KV label="Adapter status" value={battery.adapterStatus?.toString()} />
          </Grid>
        )}
      </Section>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{children}</div>;
}

function KV({ label, value }: { label: string; value: string | undefined }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
        {label}
      </span>
      <span className="text-xs font-mono text-[var(--color-foreground)] break-all">
        {value && value.length > 0 ? value : "—"}
      </span>
    </div>
  );
}
