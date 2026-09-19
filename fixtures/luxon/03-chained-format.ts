import { DateTime } from 'luxon';

export function nextWeekLabel(): string {
  return DateTime.now().plus({ days: 7 }).toFormat('yyyy-MM-dd');
}
