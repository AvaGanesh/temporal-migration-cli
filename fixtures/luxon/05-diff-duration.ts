import { DateTime } from 'luxon';

export function daysBetween(a: string, b: string): number {
  const start = DateTime.fromISO(a);
  const end = DateTime.fromISO(b);
  return end.diff(start, 'days').days;
}
