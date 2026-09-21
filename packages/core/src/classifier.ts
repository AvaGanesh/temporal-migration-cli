/**
 * Module 2 — Classifier.
 *
 * Pure function of UsageSite[] (as produced by the Scanner) -> Classification[].
 * No ts-morph/AST access here by design: the scanner's chainText + flowContext
 * already carry every signal these heuristics need, which keeps this module
 * trivially testable and keeps the "first confident match wins" rule order
 * front and center.
 *
 * Rule order (first match wins), per the plan:
 *   1. timezone signal                                -> ZonedDateTime, high
 *   2. .diff(...) / duration(...) in the chain itself  -> Duration, high
 *   3. Instant-like origin, or </> comparison w/o       -> Instant, medium
 *      calendar/time-field access
 *   4. calendar-field access, no time/timezone         -> PlainDate, medium
 *   5. time-of-day field access, no timezone           -> PlainDateTime, medium
 *   6. none of the above                               -> AMBIGUOUS, low
 *
 * Known gap (documented, not silently guessed around): the plan's Duration
 * rule also covers "the result is used in arithmetic with another date-like
 * value" (e.g. `end - start`). The Scanner does not currently tag arithmetic
 * operators (+/-) in flowContext, only relational/equality comparisons, so
 * that sub-case isn't detected yet — such sites fall through to AMBIGUOUS
 * rather than being misclassified.
 */
import type { Classification, FlowUse, TemporalType, UsageSite } from './types.js';

const CALENDAR_FIELD_NAMES = new Set(['year', 'month', 'day']);
const TIME_FIELD_NAMES = new Set(['hour', 'minute', 'second']);

const CALENDAR_FIELD_PATTERN = /\.(year|month|day)\b/;
const TIME_FIELD_PATTERN = /\.(hour|minute|second)\b/;
const DURATION_PATTERN = /\.diff\(|\bDuration\.|\bduration\(/;
const INSTANT_ORIGIN_PATTERN = /\bDate\.now\(\)|\.valueOf\(\)|\.toMillis\(\)|^\+new Date\(/;

function hasTimezoneSignal(chainText: string, flowContext: FlowUse[]): boolean {
  return (
    flowContext.includes('timezone-arg:present') || /\.setZone\(|\.tz\(|\.toUTC\(/.test(chainText)
  );
}

function chainedCallFieldNames(flowContext: FlowUse[]): string[] {
  return flowContext
    .filter((f) => f.startsWith('chained-call:'))
    .map((f) => f.slice('chained-call:'.length));
}

/**
 * A calendar/time field access "on" this usage site either appears directly
 * in its own chainText (e.g. `dt.year`), or is inferred by looking through a
 * variable assignment at a later chained-call reading that field (e.g.
 * `const dt = DateTime.fromISO(x); dt.year` — the origin call's usage site
 * gets 'chained-call:year' and should be classified the same way).
 *
 * This lookahead is intentionally restricted to bare field-getter names —
 * it must NOT be extended to transformational methods like .diff()/.plus(),
 * since e.g. `dt.diff(...)` reveals nothing about dt's own type, only about
 * the (different) type of its result.
 */
function accessesField(chainText: string, flowContext: FlowUse[], names: Set<string>): boolean {
  const directMatch = chainText.match(
    names === CALENDAR_FIELD_NAMES ? CALENDAR_FIELD_PATTERN : TIME_FIELD_PATTERN,
  );
  if (directMatch && names.has(directMatch[1])) return true;
  return chainedCallFieldNames(flowContext).some((name) => names.has(name));
}

function comparedWithRelationalOperator(flowContext: FlowUse[]): boolean {
  return flowContext.some((f) => {
    const parts = f.split(':');
    return parts[0] === 'compared-to' && (parts[2] === '<' || parts[2] === '>');
  });
}

function classifyUsageSite(site: UsageSite): Classification {
  const { chainText, flowContext } = site;

  if (hasTimezoneSignal(chainText, flowContext)) {
    return {
      usageSiteId: site.id,
      guess: 'ZonedDateTime',
      confidence: 'high',
      reason: 'chain sets or carries a timezone (setZone/tz/toUTC or a zone argument)',
    };
  }

  if (DURATION_PATTERN.test(chainText)) {
    return {
      usageSiteId: site.id,
      guess: 'Duration',
      confidence: 'high',
      reason: 'chain includes a .diff(...)/duration(...) call, producing a Duration',
    };
  }

  const calendarAccess = accessesField(chainText, flowContext, CALENDAR_FIELD_NAMES);
  const timeAccess = accessesField(chainText, flowContext, TIME_FIELD_NAMES);

  if (
    INSTANT_ORIGIN_PATTERN.test(chainText) ||
    (comparedWithRelationalOperator(flowContext) && !calendarAccess && !timeAccess)
  ) {
    const reason = INSTANT_ORIGIN_PATTERN.test(chainText)
      ? 'chain originates from a timestamp-producing call (Date.now()/valueOf()/toMillis())'
      : 'value is compared with a relational operator (</>)  against another date-like value, with no calendar/time-field access';
    return { usageSiteId: site.id, guess: 'Instant', confidence: 'medium', reason };
  }

  if (calendarAccess && !timeAccess) {
    return {
      usageSiteId: site.id,
      guess: 'PlainDate',
      confidence: 'medium',
      reason: 'chain accesses only calendar field(s) (year/month/day), never a time-of-day field',
    };
  }

  if (timeAccess) {
    return {
      usageSiteId: site.id,
      guess: 'PlainDateTime',
      confidence: 'medium',
      reason: 'chain accesses time-of-day field(s) (hour/minute/second) with no timezone signal',
    };
  }

  return {
    usageSiteId: site.id,
    guess: 'AMBIGUOUS',
    confidence: 'low',
    reason:
      'no calendar/time-field access, no duration or timezone signal, and no timestamp-like comparison detected from usage alone — needs manual review',
  };
}

export function classifyUsageSites(sites: UsageSite[]): Classification[] {
  return sites.map(classifyUsageSite);
}

export const TEMPORAL_TYPES: TemporalType[] = [
  'PlainDate',
  'PlainDateTime',
  'PlainTime',
  'ZonedDateTime',
  'Instant',
  'Duration',
];
