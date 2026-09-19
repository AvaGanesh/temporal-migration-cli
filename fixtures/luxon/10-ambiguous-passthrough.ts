import { DateTime } from 'luxon';

declare function persist(value: unknown): void;

export function saveTimestamp(iso: string): void {
  const value = DateTime.fromISO(iso);
  persist(value);
}
