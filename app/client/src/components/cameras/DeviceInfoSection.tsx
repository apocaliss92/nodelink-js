import { Battery, BatteryCharging } from 'lucide-react';
import type { CameraInfo } from './types';

interface DeviceInfoSectionProps {
  camera: CameraInfo;
}

function BatteryValue({ camera }: { camera: CameraInfo }) {
  const b = camera.batteryState;
  if (!b) return null;
  const charging = b.chargeStatus === 'charging' || b.adapterStatus === 'solarPanel';
  const Icon = charging ? BatteryCharging : Battery;
  return (
    <span className="flex items-center gap-1">
      <Icon size={11} className={charging ? 'text-[var(--color-success)]' : ''} />
      {b.percent}%
      {charging && <span className="text-[var(--color-success)] text-[10px]">(charging)</span>}
    </span>
  );
}

export function DeviceInfoSection({ camera }: DeviceInfoSectionProps) {
  const items = [
    { key: 'Model', value: camera.deviceInfo?.model ?? 'Unknown' },
    { key: 'IP', value: `${camera.host}:${camera.port}` },
    { key: 'Firmware', value: camera.deviceInfo?.firmwareVersion ?? 'N/A' },
    { key: 'Channels', value: String(camera.deviceInfo?.channelCount ?? 1) },
  ];

  return (
    <div className="rounded-lg bg-[var(--color-surface)] p-3">
      <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--color-foreground-subtle)]">
        Device Info
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {items.map((item) => (
          <div key={item.key} className="contents">
            <dt className="text-[var(--color-foreground-muted)]">{item.key}</dt>
            <dd>{item.value}</dd>
          </div>
        ))}
        {camera.batteryState && (
          <div className="contents">
            <dt className="text-[var(--color-foreground-muted)]">Battery</dt>
            <dd><BatteryValue camera={camera} /></dd>
          </div>
        )}
      </dl>
    </div>
  );
}
