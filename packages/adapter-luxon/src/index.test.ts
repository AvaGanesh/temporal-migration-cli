import { describe, expect, it } from 'vitest';
import type { Classification, ParsedCallChain } from '@temporal-migrate/core';
import { luxonAdapter } from './index.js';

function chain(rootText: string, links: ParsedCallChain['links'] = []): ParsedCallChain {
  return { usageSiteId: 'site-1', rootText, links };
}

function classification(guess: Classification['guess']): Classification {
  return { usageSiteId: 'site-1', guess, confidence: 'high', reason: 'test' };
}

describe('luxonAdapter.mapUsageSite', () => {
  it('maps DateTime.now() per classification', () => {
    expect(
      luxonAdapter.mapUsageSite(
        chain('DateTime', [{ method: 'now', args: [] }]),
        classification('Instant'),
      ),
    ).toEqual({
      type: 'rewrite',
      usageSiteId: 'site-1',
      newText: 'Temporal.Now.instant()',
      requiresTemporalImport: true,
    });

    expect(
      luxonAdapter.mapUsageSite(
        chain('DateTime', [{ method: 'now', args: [] }]),
        classification('ZonedDateTime'),
      ),
    ).toMatchObject({ newText: 'Temporal.Now.zonedDateTimeISO()' });

    expect(
      luxonAdapter.mapUsageSite(
        chain('DateTime', [{ method: 'now', args: [] }]),
        classification('PlainDate'),
      ),
    ).toMatchObject({ newText: 'Temporal.Now.plainDateISO()' });
  });

  it('maps DateTime.fromISO(s) per classification', () => {
    expect(
      luxonAdapter.mapUsageSite(
        chain('DateTime', [{ method: 'fromISO', args: ['iso'] }]),
        classification('PlainDate'),
      ),
    ).toEqual({
      type: 'rewrite',
      usageSiteId: 'site-1',
      newText: 'Temporal.PlainDate.from(iso)',
      requiresTemporalImport: true,
    });

    expect(
      luxonAdapter.mapUsageSite(
        chain('DateTime', [{ method: 'fromISO', args: ['iso'] }]),
        classification('PlainDateTime'),
      ),
    ).toMatchObject({ newText: 'Temporal.PlainDateTime.from(iso)' });
  });

  it('maps .plus/.minus/.setZone on a plain variable root, assuming it is already Temporal', () => {
    expect(
      luxonAdapter.mapUsageSite(
        chain('dt', [{ method: 'plus', args: ['{ days: 1 }'] }]),
        classification('PlainDate'),
      ),
    ).toEqual({
      type: 'rewrite',
      usageSiteId: 'site-1',
      newText: 'dt.add({ days: 1 })',
      requiresTemporalImport: false,
    });

    expect(
      luxonAdapter.mapUsageSite(
        chain('dt', [{ method: 'minus', args: ['{ days: 1 }'] }]),
        classification('PlainDate'),
      ),
    ).toMatchObject({ newText: 'dt.subtract({ days: 1 })' });

    expect(
      luxonAdapter.mapUsageSite(
        chain('dt', [{ method: 'setZone', args: ["'utc'"] }]),
        classification('ZonedDateTime'),
      ),
    ).toMatchObject({ newText: "dt.withTimeZone('utc')" });
  });

  it('collapses .diff(x, "unit") + trailing .unit into .since(x).total("unit")', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('end', [
        { method: 'diff', args: ['start', "'days'"] },
        { method: 'days', args: [] },
      ]),
      classification('Duration'),
    );
    expect(result).toEqual({
      type: 'rewrite',
      usageSiteId: 'site-1',
      newText: "end.since(start).total('days')",
      requiresTemporalImport: false,
    });
  });

  it('flags .diff(...) for manual review when not followed by a matching unit accessor', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('end', [
        { method: 'diff', args: ['start', "'days'"] },
        { method: 'toObject', args: [] },
      ]),
      classification('Duration'),
    );
    expect(result.type).toBe('manual-review');
  });

  it('passes bare calendar/time getters through unchanged', () => {
    expect(
      luxonAdapter.mapUsageSite(
        chain('first', [{ method: 'year', args: [] }]),
        classification('PlainDate'),
      ),
    ).toEqual({
      type: 'rewrite',
      usageSiteId: 'site-1',
      newText: 'first.year',
      requiresTemporalImport: false,
    });

    expect(
      luxonAdapter.mapUsageSite(
        chain('meeting', [{ method: 'hour', args: [] }]),
        classification('PlainDateTime'),
      ),
    ).toMatchObject({ newText: 'meeting.hour' });
  });

  it('flags Interval for manual review — no direct Temporal equivalent', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('Interval', [{ method: 'fromDateTimes', args: ['a', 'b'] }]),
      classification('Instant'),
    );
    expect(result.type).toBe('manual-review');
  });

  it('flags format/serialization methods for manual review (Module 5 not implemented yet)', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('DateTime', [
        { method: 'now', args: [] },
        { method: 'toFormat', args: ["'yyyy-MM-dd'"] },
      ]),
      classification('PlainDate'),
    );
    expect(result.type).toBe('manual-review');
  });

  it('flags an unmapped method for manual review instead of guessing', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('dt', [{ method: 'someUnmappedMethod', args: [] }]),
      classification('PlainDate'),
    );
    expect(result.type).toBe('manual-review');
  });

  it('refuses to map an AMBIGUOUS classification rather than guessing', () => {
    const result = luxonAdapter.mapUsageSite(
      chain('DateTime', [{ method: 'now', args: [] }]),
      classification('AMBIGUOUS'),
    );
    expect(result.type).toBe('manual-review');
  });
});
