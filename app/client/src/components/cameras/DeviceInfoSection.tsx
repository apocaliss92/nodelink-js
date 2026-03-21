import type { CameraInfo } from './types';

interface DeviceInfoSectionProps {
  camera: CameraInfo;
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
      </dl>
    </div>
  );
}
