import { DateTime } from 'luxon';

export function isBeforeToday(dateStr: string): boolean {
  const parsed = DateTime.fromISO(dateStr);
  const today = DateTime.now();
  return parsed < today;
}
