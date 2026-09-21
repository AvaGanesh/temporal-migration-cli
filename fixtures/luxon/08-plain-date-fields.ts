import { DateTime } from 'luxon';

export function isSameYear(a: string, b: string): boolean {
  const first = DateTime.fromISO(a);
  const second = DateTime.fromISO(b);
  return first.year === second.year;
}
