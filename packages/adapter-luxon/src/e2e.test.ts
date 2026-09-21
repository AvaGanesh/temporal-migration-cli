import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyUsageSites, runRewriter, scanProject } from '@temporal-migrate/core';
import { luxonAdapter } from './index.js';

const FIXTURES_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../fixtures/luxon',
);

const sites = scanProject({ rootDir: FIXTURES_DIR });
const classifications = classifyUsageSites(sites);
const result = runRewriter({
  rootDir: FIXTURES_DIR,
  sites,
  classifications,
  adapter: luxonAdapter,
});

function diffFor(fileName: string) {
  const fileDiff = result.fileDiffs.find((f) => f.file.endsWith(fileName));
  if (!fileDiff)
    throw new Error(`no FileDiff for ${fileName} — was it expected to have zero rewrites?`);
  return fileDiff.diff;
}

describe('end-to-end: scan -> classify -> luxonAdapter -> runRewriter on the fixtures', () => {
  it('produces no FileDiff for files where every site is AMBIGUOUS (01, 03, 07, 10)', () => {
    for (const f of [
      '01-basic-now.ts',
      '03-chained-format.ts',
      '07-stored-on-object.ts',
      '10-ambiguous-passthrough.ts',
    ]) {
      expect(result.fileDiffs.find((fd) => fd.file.endsWith(f))).toBeUndefined();
    }
  });

  it('rewrites both confidently-classified Instant sites in 02', () => {
    const diff = diffFor('02-parse-and-compare.ts');
    expect(diff).toContain('Temporal.Instant.from(dateStr)');
    expect(diff).toContain('Temporal.Now.instant()');
  });

  it('rewrites the ZonedDateTime site in 04, leaving the AMBIGUOUS zoned.toISO() site alone', () => {
    const diff = diffFor('04-timezone.ts');
    expect(diff).toContain("Temporal.ZonedDateTime.from(isoDate).withTimeZone('Asia/Tokyo')");
    // zoned.toISO() stays untouched — it's a manual-review site, not part of this file's rewrite.
    const manualReview = result.manualReviewFlags.find((f) => {
      const site = sites.find((s) => s.id === f.usageSiteId);
      return site?.file.endsWith('04-timezone.ts') && site.chainText === 'zoned.toISO()';
    });
    expect(manualReview).toBeDefined();
  });

  it('collapses .diff(...).days into .since().total() in 05, without touching its AMBIGUOUS operands', () => {
    const diff = diffFor('05-diff-duration.ts');
    expect(diff).toContain("end.since(start).total('days')");
    // start/end's own DateTime.fromISO(...) origin calls are AMBIGUOUS and must remain untouched.
    expect(diff).toContain('DateTime.fromISO(a)');
    expect(diff).toContain('DateTime.fromISO(b)');
  });

  it('rewrites only the setZone call in the 06 reassignment chain', () => {
    const diff = diffFor('06-reassignment.ts');
    expect(diff).toContain("dt.withTimeZone('utc')");
  });

  it('rewrites both origins in 08 to PlainDate.from, and leaves the .year reads as true no-ops', () => {
    const diff = diffFor('08-plain-date-fields.ts');
    expect(diff).toContain('Temporal.PlainDate.from(a)');
    expect(diff).toContain('Temporal.PlainDate.from(b)');
    // .year needs no rewrite — it must not show up as a changed ("+") line.
    expect(diff).not.toMatch(/^\+.*\.year/m);
  });

  it('rewrites the origin in 09 to PlainDateTime.from, and leaves .hour as a true no-op', () => {
    const diff = diffFor('09-plain-date-time-fields.ts');
    expect(diff).toContain('Temporal.PlainDateTime.from(iso)');
    expect(diff).not.toMatch(/^\+.*\.hour/m);
  });

  it('flags exactly the 10 AMBIGUOUS sites for manual review, and rewrites the other 11', () => {
    const ambiguousCount = classifications.filter((c) => c.guess === 'AMBIGUOUS').length;
    expect(ambiguousCount).toBe(10);
    expect(result.manualReviewFlags).toHaveLength(10);

    const totalRewritten = result.fileDiffs.reduce((n, f) => n + f.rewrittenSiteIds.length, 0);
    expect(totalRewritten).toBe(11);
    expect(sites).toHaveLength(21);
  });

  it('never lets a manual-review site slip into a rewrite, or vice versa', () => {
    const rewrittenIds = new Set(result.fileDiffs.flatMap((f) => f.rewrittenSiteIds));
    const manualIds = new Set(result.manualReviewFlags.map((f) => f.usageSiteId));
    for (const site of sites) {
      expect(rewrittenIds.has(site.id) && manualIds.has(site.id)).toBe(false);
      expect(rewrittenIds.has(site.id) || manualIds.has(site.id)).toBe(true);
    }
  });
});
