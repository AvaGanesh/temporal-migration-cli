import { DateTime } from 'luxon';

export function tokyoTime(isoDate: string): string {
  const zoned = DateTime.fromISO(isoDate).setZone('Asia/Tokyo');
  return zoned.toISO();
}
