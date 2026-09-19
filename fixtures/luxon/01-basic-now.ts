import { DateTime } from 'luxon';

export function getCurrentIsoDate(): string {
  return DateTime.now().toISODate();
}
