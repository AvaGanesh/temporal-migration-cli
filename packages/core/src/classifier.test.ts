import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from './scanner.js';
import { classifyUsageSites } from './classifier.js';
import type { Classification, UsageSite } from './types.js';

const FIXTURES_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../fixtures/luxon',
);

const sites = scanProject({ rootDir: FIXTURES_DIR });
const classifications = classifyUsageSites(sites);
const byId = new Map<string, Classification>(classifications.map((c) => [c.usageSiteId, c]));

function resultsForFile(fileName: string) {
  return sites
    .filter((s) => s.file.endsWith(fileName))
    .map((s) => {
      const c = byId.get(s.id)!;
      return { chainText: s.chainText, guess: c.guess, confidence: c.confidence };
    });
}

describe('classifyUsageSites (hand-labeled fixture expectations)', () => {
  it('flags an unadorned chain with no modeled signal as AMBIGUOUS (01, 03)', () => {
    expect(resultsForFile('01-basic-now.ts')).toEqual([
      { chainText: 'DateTime.now().toISODate()', guess: 'AMBIGUOUS', confidence: 'low' },
    ]);
    expect(resultsForFile('03-chained-format.ts')).toEqual([
      {
        chainText: "DateTime.now().plus({ days: 7 }).toFormat('yyyy-MM-dd')",
        guess: 'AMBIGUOUS',
        confidence: 'low',
      },
    ]);
  });

  it('classifies a relational (</>) comparison with no calendar/time access as Instant (02)', () => {
    expect(resultsForFile('02-parse-and-compare.ts')).toEqual([
      { chainText: 'DateTime.fromISO(dateStr)', guess: 'Instant', confidence: 'medium' },
      { chainText: 'DateTime.now()', guess: 'Instant', confidence: 'medium' },
    ]);
  });

  it('classifies a setZone chain as ZonedDateTime, but does not propagate that to a downstream unrelated call (04)', () => {
    expect(resultsForFile('04-timezone.ts')).toEqual([
      {
        chainText: "DateTime.fromISO(isoDate).setZone('Asia/Tokyo')",
        guess: 'ZonedDateTime',
        confidence: 'high',
      },
      { chainText: 'zoned.toISO()', guess: 'AMBIGUOUS', confidence: 'low' },
    ]);
  });

  it('classifies a .diff(...) chain as Duration, and does not misclassify the operands (05)', () => {
    expect(resultsForFile('05-diff-duration.ts')).toEqual([
      { chainText: 'DateTime.fromISO(a)', guess: 'AMBIGUOUS', confidence: 'low' },
      { chainText: 'DateTime.fromISO(b)', guess: 'AMBIGUOUS', confidence: 'low' },
      { chainText: "end.diff(start, 'days').days", guess: 'Duration', confidence: 'high' },
    ]);
  });

  it('classifies only the setZone call as ZonedDateTime across a reassignment chain (06)', () => {
    expect(resultsForFile('06-reassignment.ts')).toEqual([
      { chainText: 'DateTime.now()', guess: 'AMBIGUOUS', confidence: 'low' },
      { chainText: 'dt.plus({ days: 1 })', guess: 'AMBIGUOUS', confidence: 'low' },
      { chainText: "dt.setZone('utc')", guess: 'ZonedDateTime', confidence: 'high' },
      { chainText: 'dt.toISO()', guess: 'AMBIGUOUS', confidence: 'low' },
    ]);
  });

  it('flags a value merely stored on an object as AMBIGUOUS (07)', () => {
    expect(resultsForFile('07-stored-on-object.ts')).toEqual([
      { chainText: 'DateTime.now()', guess: 'AMBIGUOUS', confidence: 'low' },
    ]);
  });

  it('looks through a variable assignment to a later .year access and classifies as PlainDate (08)', () => {
    expect(resultsForFile('08-plain-date-fields.ts')).toEqual([
      { chainText: 'DateTime.fromISO(a)', guess: 'PlainDate', confidence: 'medium' },
      { chainText: 'DateTime.fromISO(b)', guess: 'PlainDate', confidence: 'medium' },
      { chainText: 'first.year', guess: 'PlainDate', confidence: 'medium' },
      { chainText: 'second.year', guess: 'PlainDate', confidence: 'medium' },
    ]);
  });

  it('does not let an equality comparison of calendar fields get misclassified as Instant (08)', () => {
    // first.year === second.year uses '===', not '<'/'>', so the Instant rule
    // must not fire even though there's a compared-to flow tag present.
    const results = resultsForFile('08-plain-date-fields.ts');
    expect(results.every((r) => r.guess !== 'Instant')).toBe(true);
  });

  it('looks through a variable assignment to a later .hour access and classifies as PlainDateTime (09)', () => {
    expect(resultsForFile('09-plain-date-time-fields.ts')).toEqual([
      { chainText: 'DateTime.fromISO(iso)', guess: 'PlainDateTime', confidence: 'medium' },
      { chainText: 'meeting.hour', guess: 'PlainDateTime', confidence: 'medium' },
    ]);
  });

  it('flags a value passed to a function with an unknown parameter type as AMBIGUOUS, not guessed (10)', () => {
    expect(resultsForFile('10-ambiguous-passthrough.ts')).toEqual([
      { chainText: 'DateTime.fromISO(iso)', guess: 'AMBIGUOUS', confidence: 'low' },
    ]);
  });

  it('never produces AMBIGUOUS at anything other than low confidence, and every AMBIGUOUS has a reason', () => {
    for (const c of classifications) {
      if (c.guess === 'AMBIGUOUS') {
        expect(c.confidence).toBe('low');
      } else {
        expect(['high', 'medium']).toContain(c.confidence);
      }
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });

  it('classifies every usage site exactly once', () => {
    expect(classifications).toHaveLength(sites.length);
    const ids = new Set(classifications.map((c) => c.usageSiteId));
    expect(ids.size).toBe(sites.length);
  });
});
