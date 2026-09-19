import { DateTime } from 'luxon';

export function scheduleFollowUp(): string {
  let dt = DateTime.now();
  dt = dt.plus({ days: 1 });
  dt = dt.setZone('utc');
  return dt.toISO();
}
