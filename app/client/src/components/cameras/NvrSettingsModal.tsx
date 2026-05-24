import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent } from "@camstack/ui-library";
import {
  X,
  Cpu,
  HardDrive,
  Users,
  Globe,
  Clock,
  Tv,
  Plus,
  CheckCircle2,
  RefreshCw,
  Wrench,
  Power,
  AlertCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Section,
  Field,
  FieldGrid,
  TextInput,
  Toggle,
  RangeInput,
  Select,
} from "./settings-tabs/shared";
import { trpcQuery, trpcMutation } from "../../api";

/**
 * NVR/Hub settings modal — device-level operations (cmd_ids that target
 * the NVR itself, not a specific channel).
 *
 * All tRPC calls pass `nvrId` (resolved server-side via
 * `connection-manager.resolveCredentials` to the NVR's host/credentials).
 * Channel-scoped operations (motion zones, AI per class, privacy mask,
 * OSD, image, audio) intentionally live on the per-channel
 * CameraSettingsModal — open a child camera to access those.
 */

/** Minimal shape passed from CamerasPage so the Channels tab can show
 * which channels are already wired up as child cameras. */
export interface NvrChildSummary {
  /** Existing camera id (so we can offer "remove" later). */
  id: string;
  /** rtspChannel = the NVR channel number this camera is bound to. */
  channel: number;
}

interface NvrSettingsModalProps {
  open: boolean;
  nvrId: string;
  nvrName: string;
  onClose: () => void;
  /** Already-added child cameras for this NVR — for the Channels tab. */
  existingChildren?: NvrChildSummary[];
  /** Called after a channel is added so the parent can refresh its list. */
  onChannelAdded?: () => void;
}

interface NvrTabProps {
  nvrId: string;
  existingChildren?: NvrChildSummary[];
  onChannelAdded?: () => void;
}

interface TabDef {
  id: string;
  label: string;
  icon: LucideIcon;
  hint: string;
  Component: React.ComponentType<NvrTabProps>;
}

const TABS: TabDef[] = [
  {
    id: "device",
    label: "Device",
    icon: Cpu,
    hint: "Model, firmware, serial number, UID.",
    Component: DeviceTab,
  },
  {
    id: "channels",
    label: "Channels",
    icon: Tv,
    hint: "Discover the NVR's channels and add them as cameras.",
    Component: ChannelsTab,
  },
  {
    id: "storage",
    label: "Storage",
    icon: HardDrive,
    hint: "HDD/SSD/SD-card listing — capacity, format, mount state.",
    Component: StorageTab,
  },
  {
    id: "network",
    label: "Network",
    icon: Globe,
    hint: "Ports, Wi-Fi signal (read-only).",
    Component: NetworkTab,
  },
  {
    id: "users",
    label: "Users",
    icon: Users,
    hint: "Access user list — who can log into this NVR.",
    Component: UsersTab,
  },
  {
    id: "time",
    label: "Time",
    icon: Clock,
    hint: "NTP, timezone, daylight-saving config.",
    Component: TimeTab,
  },
  {
    id: "maintenance",
    label: "Maintenance",
    icon: Wrench,
    hint: "Auto-reboot schedule + manual reboot.",
    Component: MaintenanceTab,
  },
];

export function NvrSettingsModal({
  open,
  nvrId,
  nvrName,
  onClose,
  existingChildren,
  onChannelAdded,
}: NvrSettingsModalProps) {
  const [activeTabId, setActiveTabId] = useState<string>(TABS[0]!.id);
  const activeTab = TABS.find((t) => t.id === activeTabId) ?? TABS[0]!;
  const ActiveComponent = activeTab.Component;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        width="lg"
        className="m-auto max-w-[1080px] w-[95vw] h-[85vh] p-0 overflow-hidden bg-[var(--color-background-elevated)] text-[var(--color-foreground)] border-[var(--color-border)]"
      >
        <div className="flex h-full w-full">
          <aside className="w-[200px] shrink-0 border-r border-[var(--color-border)] bg-[var(--color-surface)] py-3 overflow-y-auto">
            <div className="px-3 pb-3 border-b border-[var(--color-border)] mb-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                NVR settings
              </div>
              <div className="text-[13px] font-semibold text-[var(--color-foreground)] truncate">
                {nvrName}
              </div>
            </div>
            <nav className="flex flex-col gap-0.5 px-2">
              {TABS.map((tab) => {
                const Icon = tab.icon;
                const active = tab.id === activeTabId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setActiveTabId(tab.id)}
                    className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] text-left transition-colors ${
                      active
                        ? "bg-[var(--color-accent,#22d3ee)]/10 text-[var(--color-foreground)] border border-[var(--color-accent,#22d3ee)]/30"
                        : "text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] hover:bg-[var(--color-surface-hover)] border border-transparent"
                    }`}
                  >
                    <Icon size={14} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </aside>
          <section className="flex-1 flex flex-col min-w-0">
            <header className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3 bg-[var(--color-background)]">
              <div>
                <div className="text-[13px] font-semibold text-[var(--color-foreground)]">
                  {activeTab.label}
                </div>
                <div className="text-[11px] text-[var(--color-foreground-muted)]">
                  {activeTab.hint}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded hover:bg-[var(--color-surface-hover)] text-[var(--color-foreground-muted)] hover:text-[var(--color-foreground)] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </header>
            <main className="flex-1 overflow-y-auto p-4 bg-[var(--color-background)]">
              <ActiveComponent
                nvrId={nvrId}
                {...(existingChildren !== undefined ? { existingChildren } : {})}
                {...(onChannelAdded !== undefined ? { onChannelAdded } : {})}
              />
            </main>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/* ────────────────────── Tabs ──────────────────────── */

interface DiscoveredChannel {
  channel: number;
  name: string;
  model: string;
  uid: string;
  state: string;
  online: boolean;
  isMultifocal: boolean;
  isBattery: boolean;
  isDoorbell: boolean;
  ip: string;
}

interface DiscoverResult {
  success: boolean;
  error?: string;
  nvrName: string;
  channelCount: number;
  channels: DiscoveredChannel[];
}

function ChannelsTab({ nvrId, existingChildren, onChannelAdded }: NvrTabProps) {
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [addingChannel, setAddingChannel] = useState<number | null>(null);

  const existingByChannel = new Map<number, string>(
    (existingChildren ?? []).map((c) => [c.channel, c.id] as const),
  );

  const discover = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await trpcMutation<DiscoverResult, { nvrId: string }>(
        "cameras.discoverNvrChannels",
        { nvrId },
      );
      if (!r.success) {
        setErr(r.error ?? "Discovery failed");
        setResult(null);
      } else {
        setResult(r);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [nvrId]);

  useEffect(() => {
    void discover();
  }, [discover]);

  const addChannel = useCallback(
    async (ch: DiscoveredChannel) => {
      setAddingChannel(ch.channel);
      setErr(null);
      try {
        await trpcMutation("cameras.addNvrCamera", {
          nvrId,
          channelName: ch.name,
          channelNumber: ch.channel,
          isBattery: ch.isBattery,
        });
        onChannelAdded?.();
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setAddingChannel(null);
      }
    },
    [nvrId, onChannelAdded],
  );

  return (
    <Section
      title="Channels"
      description="Channels exposed by the NVR via cmd_id 145. Already-added channels are tracked by `rtspChannel`; the rest can be added as standalone-looking camera entries (they still share the NVR's underlying connection)."
    >
      <div className="flex items-center gap-2 mb-3">
        <button
          type="button"
          onClick={() => void discover()}
          disabled={loading}
          className="inline-flex items-center gap-1 text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          {loading ? "Discovering…" : "Refresh"}
        </button>
        {result ? (
          <span className="text-[11px] text-[var(--color-foreground-muted)]">
            {result.channelCount} channels reported
          </span>
        ) : null}
      </div>

      {err ? (
        <div className="text-[11px] text-red-300 mb-3">{err}</div>
      ) : null}

      {!result && loading ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          Discovering channels…
        </div>
      ) : result && result.channels.length === 0 ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          NVR reported zero channels.
        </div>
      ) : result ? (
        <div className="flex flex-col gap-2">
          {result.channels.map((ch) => {
            const existingId = existingByChannel.get(ch.channel);
            const isAdding = addingChannel === ch.channel;
            return (
              <div
                key={ch.channel}
                className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2"
              >
                <div className="w-8 text-center text-[11px] font-mono text-[var(--color-foreground-muted)]">
                  #{ch.channel}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-semibold text-[var(--color-foreground)] truncate">
                      {ch.name}
                    </span>
                    {ch.online ? (
                      <span className="text-[9px] uppercase tracking-wider text-emerald-400">
                        online
                      </span>
                    ) : (
                      <span className="text-[9px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
                        offline
                      </span>
                    )}
                    {ch.isBattery && (
                      <span className="text-[9px] uppercase tracking-wider text-amber-400">
                        battery
                      </span>
                    )}
                    {ch.isMultifocal && (
                      <span className="text-[9px] uppercase tracking-wider text-cyan-400">
                        multifocal
                      </span>
                    )}
                    {ch.isDoorbell && (
                      <span className="text-[9px] uppercase tracking-wider text-purple-400">
                        doorbell
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] font-mono text-[var(--color-foreground-muted)] truncate">
                    {ch.model || "—"} · {ch.uid || "no UID"}
                    {ch.ip ? ` · ${ch.ip}` : ""}
                  </div>
                </div>
                {existingId ? (
                  <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                    <CheckCircle2 size={11} />
                    Added
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void addChannel(ch)}
                    disabled={isAdding}
                    className="inline-flex items-center gap-1 text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
                  >
                    <Plus size={11} />
                    {isAdding ? "Adding…" : "Add as camera"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
    </Section>
  );
}


interface VersionInfo {
  name?: string;
  type?: string;
  serialNumber?: string;
  buildDay?: string;
  hardwareVersion?: string;
  firmwareVersion?: string;
  detail?: string;
  itemNo?: string;
  aiVersion?: string;
}

function DeviceTab({ nvrId }: NvrTabProps) {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [uid, setUid] = useState<string | null>(null);
  const [system, setSystem] = useState<unknown>(null);
  const [versionErr, setVersionErr] = useState<string | null>(null);
  const [systemErr, setSystemErr] = useState<string | null>(null);

  useEffect(() => {
    void trpcQuery<VersionInfo>("baichuan.getVersionInfo", { nvrId })
      .then(setVersion)
      .catch((e) => setVersionErr(e instanceof Error ? e.message : String(e)));
    void trpcQuery<string>("baichuan.getUid", { nvrId })
      .then((v) => setUid(typeof v === "string" ? v : null))
      .catch(() => setUid(null));
    void trpcQuery<unknown>("baichuan.getSystemGeneral", { nvrId, channel: 0 })
      .then(setSystem)
      .catch((e) => setSystemErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  return (
    <div>
      <Section
        title="Device"
        description="Identification — model, firmware, serial. Same fields the Reolink app shows in 'About this device'."
      >
        {versionErr ? (
          <div className="text-[11px] text-red-300">{versionErr}</div>
        ) : !version ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <Grid>
            <KV label="Name" value={version.name} />
            <KV label="Model" value={version.type} />
            <KV label="Item no." value={version.itemNo} />
            <KV label="Serial number" value={version.serialNumber} />
            <KV label="UID" value={uid ?? undefined} />
            <KV label="Firmware" value={version.firmwareVersion} />
            <KV label="Build" value={version.buildDay} />
            <KV label="Hardware" value={version.hardwareVersion} />
            <KV label="AI bundle" value={version.aiVersion} />
            <KV label="Detail" value={version.detail} />
          </Grid>
        )}
      </Section>

      <Section
        title="System general"
        description="Locale, OSD format, language. Used for the NVR's clock and recording filenames."
      >
        {systemErr ? (
          <div className="text-[11px] text-red-300">{systemErr}</div>
        ) : !system ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[200px]">
{JSON.stringify(system, null, 2)}
          </pre>
        )}
      </Section>
    </div>
  );
}

interface HddInfo {
  number?: number;
  capacity?: number;
  capacityV2?: number;
  remainSize?: number;
  remainSizeV2?: number;
  format?: number;
  mount?: number;
  type?: number;
  index?: number;
  [k: string]: unknown;
}

function StorageTab({ nvrId }: NvrTabProps) {
  const [hdds, setHdds] = useState<HddInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void trpcQuery<{ body?: { HddInfoList?: { HddInfo?: HddInfo | HddInfo[] } } }>(
      "baichuan.getHddInfoList",
      { nvrId, channel: 0 },
    )
      .then((res) => {
        const raw = res?.body?.HddInfoList?.HddInfo;
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        setHdds(list);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  return (
    <Section
      title="Storage"
      description="HDD / SSD / SD-card listing. capacityV2 / remainSizeV2 are in bytes; legacy capacity / remainSize are in GiB."
    >
      {err ? (
        <div className="text-[11px] text-red-300">{err}</div>
      ) : !hdds ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          Loading…
        </div>
      ) : hdds.length === 0 ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          No storage devices reported.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {hdds.map((h, idx) => {
            const capGb = h.capacityV2
              ? (h.capacityV2 / 1024 ** 3).toFixed(1)
              : h.capacity?.toString();
            const remainGb = h.remainSizeV2
              ? (h.remainSizeV2 / 1024 ** 3).toFixed(1)
              : h.remainSize?.toString();
            return (
              <div
                key={h.number ?? h.index ?? idx}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-background)] p-3"
              >
                <div className="text-[12px] font-semibold mb-2">
                  Drive #{h.number ?? h.index ?? idx}
                </div>
                <Grid>
                  <KV label="Capacity" value={capGb ? `${capGb} GiB` : undefined} />
                  <KV label="Free" value={remainGb ? `${remainGb} GiB` : undefined} />
                  <KV
                    label="Format"
                    value={
                      h.format === 1
                        ? "formatted"
                        : h.format === 0
                          ? "unformatted"
                          : h.format?.toString()
                    }
                  />
                  <KV
                    label="Mount"
                    value={
                      h.mount === 1
                        ? "mounted"
                        : h.mount === 0
                          ? "unmounted"
                          : h.mount?.toString()
                    }
                  />
                  <KV label="Type" value={h.type?.toString()} />
                </Grid>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function NetworkTab({ nvrId }: NvrTabProps) {
  const [network, setNetwork] = useState<unknown>(null);
  const [ports, setPorts] = useState<unknown>(null);
  const [networkErr, setNetworkErr] = useState<string | null>(null);
  const [portsErr, setPortsErr] = useState<string | null>(null);

  useEffect(() => {
    void trpcQuery<unknown>("baichuan.getNetworkInfo", { nvrId, channel: 0 })
      .then(setNetwork)
      .catch((e) => setNetworkErr(e instanceof Error ? e.message : String(e)));
    void trpcQuery<unknown>("baichuan.getPorts", { nvrId, channel: 0 })
      .then(setPorts)
      .catch((e) => setPortsErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  return (
    <div>
      <Section title="Network" description="IP / WAN configuration.">
        {networkErr ? (
          <div className="text-[11px] text-red-300">{networkErr}</div>
        ) : !network ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[260px]">
{JSON.stringify(network, null, 2)}
          </pre>
        )}
      </Section>
      <Section title="Ports" description="HTTP, RTSP, ONVIF, HTTPS ports.">
        {portsErr ? (
          <div className="text-[11px] text-red-300">{portsErr}</div>
        ) : !ports ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[260px]">
{JSON.stringify(ports, null, 2)}
          </pre>
        )}
      </Section>
    </div>
  );
}

function UsersTab({ nvrId }: NvrTabProps) {
  const [users, setUsers] = useState<unknown>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void trpcQuery<unknown>("baichuan.getAccessUserList", { nvrId, channel: 0 })
      .then(setUsers)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  return (
    <Section
      title="Access user list"
      description="Users with login access to this NVR. cmd_id 511."
    >
      {err ? (
        <div className="text-[11px] text-red-300">{err}</div>
      ) : !users ? (
        <div className="text-[11px] text-[var(--color-foreground-muted)]">
          Loading…
        </div>
      ) : (
        <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[420px]">
{JSON.stringify(users, null, 2)}
        </pre>
      )}
    </Section>
  );
}

interface NtpForm {
  enable: boolean;
  server: string;
  port: number;
  synchronizeInterval: number;
}

interface NtpResponse {
  enable?: number;
  server?: string;
  port?: number;
  synchronizeInterval?: number;
  [k: string]: unknown;
}

function readNtpForm(raw: NtpResponse | null): NtpForm {
  const n = raw ?? {};
  return {
    enable: Number(n.enable ?? 0) === 1,
    server: typeof n.server === "string" ? n.server : "",
    port: Number(n.port ?? 123),
    synchronizeInterval: Number(n.synchronizeInterval ?? 1440),
  };
}

function TimeTab({ nvrId }: NvrTabProps) {
  const [ntp, setNtp] = useState<NtpForm | null>(null);
  const [loadedNtp, setLoadedNtp] = useState<NtpForm | null>(null);
  const [dst, setDst] = useState<unknown>(null);
  const [ntpErr, setNtpErr] = useState<string | null>(null);
  const [dstErr, setDstErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(() => {
    setSaved(false);
    setNtpErr(null);
    setDstErr(null);
    void trpcQuery<NtpResponse>("baichuan.getNtp", { nvrId, channel: 0 })
      .then((r) => {
        const f = readNtpForm(r);
        setNtp(f);
        setLoadedNtp(f);
      })
      .catch((e) => setNtpErr(e instanceof Error ? e.message : String(e)));
    void trpcQuery<unknown>("baichuan.getDst", { nvrId, channel: 0 })
      .then(setDst)
      .catch((e) => setDstErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const dirty = JSON.stringify(ntp) !== JSON.stringify(loadedNtp);

  const apply = async () => {
    if (!ntp) return;
    setSaving(true);
    setNtpErr(null);
    setSaved(false);
    try {
      await trpcMutation("baichuan.setNtp", {
        nvrId,
        enable: ntp.enable ? 1 : 0,
        server: ntp.server,
        port: ntp.port,
        synchronizeInterval: ntp.synchronizeInterval,
      });
      setSaved(true);
      refresh();
    } catch (e) {
      setNtpErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <Section title="NTP" description="Network time protocol — server, port, sync interval.">
        {ntpErr && !ntp ? (
          <div className="text-[11px] text-red-300">{ntpErr}</div>
        ) : !ntp ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <>
            <FieldGrid>
              <Field label="Enabled">
                <Toggle
                  value={ntp.enable}
                  onChange={(v) => setNtp({ ...ntp, enable: v })}
                  disabled={saving}
                />
              </Field>
              <Field label="Server" hint="Hostname or IP">
                <TextInput
                  value={ntp.server}
                  onChange={(v) => setNtp({ ...ntp, server: v })}
                  disabled={saving}
                  placeholder="pool.ntp.org"
                />
              </Field>
              <Field label="Port" hint="123 by default">
                <RangeInput
                  value={ntp.port}
                  min={1}
                  max={65535}
                  onChange={(v) => setNtp({ ...ntp, port: v })}
                  disabled={saving}
                />
              </Field>
              <Field label="Sync interval" hint="Minutes between syncs">
                <RangeInput
                  value={ntp.synchronizeInterval}
                  min={1}
                  max={10080}
                  step={1}
                  unit="min"
                  onChange={(v) => setNtp({ ...ntp, synchronizeInterval: v })}
                  disabled={saving}
                />
              </Field>
            </FieldGrid>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void apply()}
                disabled={!dirty || saving}
                className="inline-flex items-center gap-1 text-[11px] rounded-md bg-[var(--color-primary)] text-white px-2 py-1 disabled:opacity-50"
              >
                Apply
              </button>
              {dirty ? (
                <button
                  type="button"
                  onClick={() => loadedNtp && setNtp(loadedNtp)}
                  disabled={saving}
                  className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
                >
                  Revert
                </button>
              ) : null}
              {saved ? (
                <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 size={11} /> Saved
                </span>
              ) : null}
              {ntpErr ? (
                <span className="text-[11px] text-red-300">{ntpErr}</span>
              ) : null}
            </div>
          </>
        )}
      </Section>
      <Section title="DST" description="Daylight-saving rules (read-only for now — submit a feature request if you need this on NVRs).">
        {dstErr ? (
          <div className="text-[11px] text-red-300">{dstErr}</div>
        ) : !dst ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <pre className="text-[11px] font-mono bg-[var(--color-background)] border border-[var(--color-border)] rounded p-2 overflow-auto max-h-[200px]">
{JSON.stringify(dst, null, 2)}
          </pre>
        )}
      </Section>
    </div>
  );
}

interface AutoRebootForm {
  enable: boolean;
  weekDay:
    | "Sunday"
    | "Monday"
    | "Tuesday"
    | "Wednesday"
    | "Thursday"
    | "Friday"
    | "Saturday"
    | "everyday";
  hour: number;
  minute: number;
}

interface AutoRebootResponse {
  enable?: number;
  weekDay?: string;
  hour?: number;
  minute?: number;
  second?: number;
  [k: string]: unknown;
}

const WEEKDAYS: AutoRebootForm["weekDay"][] = [
  "everyday",
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function readAutoRebootForm(raw: AutoRebootResponse | null): AutoRebootForm {
  const a = raw ?? {};
  const wd =
    typeof a.weekDay === "string" &&
    WEEKDAYS.includes(a.weekDay as AutoRebootForm["weekDay"])
      ? (a.weekDay as AutoRebootForm["weekDay"])
      : "everyday";
  return {
    enable: Number(a.enable ?? 0) === 1,
    weekDay: wd,
    hour: Number(a.hour ?? 3),
    minute: Number(a.minute ?? 0),
  };
}

function MaintenanceTab({ nvrId }: NvrTabProps) {
  const [reboot, setReboot] = useState<AutoRebootForm | null>(null);
  const [loaded, setLoaded] = useState<AutoRebootForm | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [rebooting, setRebooting] = useState(false);
  const [rebootMsg, setRebootMsg] = useState<string | null>(null);
  const [confirmReboot, setConfirmReboot] = useState(false);

  const refresh = useCallback(() => {
    setSaved(false);
    setErr(null);
    void trpcQuery<AutoRebootResponse>("baichuan.getAutoReboot", { nvrId })
      .then((r) => {
        const f = readAutoRebootForm(r);
        setReboot(f);
        setLoaded(f);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [nvrId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const dirty = JSON.stringify(reboot) !== JSON.stringify(loaded);

  const applySchedule = async () => {
    if (!reboot) return;
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      await trpcMutation("baichuan.setAutoReboot", {
        nvrId,
        enable: reboot.enable ? 1 : 0,
        weekDay: reboot.weekDay,
        hour: reboot.hour,
        minute: reboot.minute,
      });
      setSaved(true);
      refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const triggerReboot = async () => {
    setRebooting(true);
    setRebootMsg(null);
    try {
      const r = await trpcMutation<{ success: boolean; message?: string }>(
        "baichuan.reboot",
        { nvrId },
      );
      setRebootMsg(r.message ?? "Reboot command sent");
      setConfirmReboot(false);
    } catch (e) {
      setRebootMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRebooting(false);
    }
  };

  return (
    <div>
      <Section
        title="Auto-reboot schedule"
        description="Periodic device reboot. Maps to cmd_id 100/101. Use sparingly — Reolink defaults to weekly Sunday at 03:00."
      >
        {err && !reboot ? (
          <div className="text-[11px] text-red-300">{err}</div>
        ) : !reboot ? (
          <div className="text-[11px] text-[var(--color-foreground-muted)]">
            Loading…
          </div>
        ) : (
          <>
            <FieldGrid>
              <Field label="Enabled">
                <Toggle
                  value={reboot.enable}
                  onChange={(v) => setReboot({ ...reboot, enable: v })}
                  disabled={saving}
                />
              </Field>
              <Field label="Day">
                <Select
                  value={reboot.weekDay}
                  options={WEEKDAYS.map((w) => ({
                    value: w,
                    label: w === "everyday" ? "Every day" : w,
                  }))}
                  onChange={(v) =>
                    setReboot({
                      ...reboot,
                      weekDay: v as AutoRebootForm["weekDay"],
                    })
                  }
                  disabled={saving}
                />
              </Field>
              <Field label="Hour" hint="0–23 (24h clock)">
                <RangeInput
                  value={reboot.hour}
                  min={0}
                  max={23}
                  onChange={(v) => setReboot({ ...reboot, hour: v })}
                  disabled={saving}
                />
              </Field>
              <Field label="Minute" hint="0–59">
                <RangeInput
                  value={reboot.minute}
                  min={0}
                  max={59}
                  onChange={(v) => setReboot({ ...reboot, minute: v })}
                  disabled={saving}
                />
              </Field>
            </FieldGrid>
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void applySchedule()}
                disabled={!dirty || saving}
                className="inline-flex items-center gap-1 text-[11px] rounded-md bg-[var(--color-primary)] text-white px-2 py-1 disabled:opacity-50"
              >
                Apply
              </button>
              {dirty ? (
                <button
                  type="button"
                  onClick={() => loaded && setReboot(loaded)}
                  disabled={saving}
                  className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-2 py-1 hover:bg-[var(--color-surface-hover)]"
                >
                  Revert
                </button>
              ) : null}
              {saved ? (
                <span className="text-[11px] text-emerald-400 inline-flex items-center gap-1">
                  <CheckCircle2 size={11} /> Saved
                </span>
              ) : null}
              {err ? <span className="text-[11px] text-red-300">{err}</span> : null}
            </div>
          </>
        )}
      </Section>

      <Section
        title="Reboot now"
        description="Issue an immediate reboot to the device. All open streams will drop and the camera will be offline for ~30-60 seconds."
      >
        {!confirmReboot ? (
          <button
            type="button"
            onClick={() => setConfirmReboot(true)}
            disabled={rebooting}
            className="inline-flex items-center gap-1 text-[11px] rounded-md border border-amber-600/40 bg-amber-500/10 text-amber-200 px-3 py-1.5 hover:bg-amber-500/20"
          >
            <Power size={11} />
            Reboot device
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
              <AlertCircle size={11} />
              Reboot {`'`}now? This will drop all streams.
            </span>
            <button
              type="button"
              onClick={() => void triggerReboot()}
              disabled={rebooting}
              className="text-[11px] rounded-md bg-red-500 text-white px-3 py-1.5 disabled:opacity-50"
            >
              {rebooting ? "Sending…" : "Yes, reboot"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmReboot(false)}
              disabled={rebooting}
              className="text-[11px] rounded-md border border-[var(--color-border)] bg-[var(--color-background)] text-[var(--color-foreground)] px-3 py-1.5 hover:bg-[var(--color-surface-hover)]"
            >
              Cancel
            </button>
          </div>
        )}
        {rebootMsg ? (
          <div className="mt-2 text-[11px] text-[var(--color-foreground-muted)]">
            {rebootMsg}
          </div>
        ) : null}
      </Section>
    </div>
  );
}

/* ────────────────────── Layout helpers ──────────────────── */

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
