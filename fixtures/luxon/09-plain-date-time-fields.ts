import { DateTime } from 'luxon';

export function meetingHour(iso: string): number {
  const meeting = DateTime.fromISO(iso);
  return meeting.hour;
}
