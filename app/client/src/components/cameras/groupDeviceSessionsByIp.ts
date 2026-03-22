import type { DeviceSession } from './types';

export type DeviceSessionIpGroup = {
  ip: string;
  items: DeviceSession[];
};

/**
 * Group OnlineUserList rows by client IP; sort groups by session count (desc), then IP.
 */
export function groupDeviceSessionsByIp(sessions: DeviceSession[]): DeviceSessionIpGroup[] {
  const map = new Map<string, DeviceSession[]>();
  for (const s of sessions) {
    const ip = (s.ip ?? '?').trim() || '?';
    const arr = map.get(ip);
    if (arr) arr.push(s);
    else map.set(ip, [s]);
  }

  return [...map.entries()]
    .map(([ip, items]) => ({
      ip,
      items: [...items].sort((a, b) =>
        (a.userName ?? '').localeCompare(b.userName ?? '', undefined, { sensitivity: 'base' }),
      ),
    }))
    .sort(
      (a, b) =>
        b.items.length - a.items.length || a.ip.localeCompare(b.ip, undefined, { numeric: true }),
    );
}
