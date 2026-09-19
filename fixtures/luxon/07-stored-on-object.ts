import { DateTime } from 'luxon';

export function buildEvent(): { createdAt: DateTime } {
  const createdAt = DateTime.now();
  return { createdAt };
}
