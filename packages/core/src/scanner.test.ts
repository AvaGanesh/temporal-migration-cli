import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanProject } from './scanner.js';
import type { UsageSite } from './types.js';

const FIXTURES_DIR = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../fixtures/luxon',
);

function sitesForFile(sites: UsageSite[], fileName: string) {
  return sites
    .filter((s) => s.file.endsWith(fileName))
    .map((s) => ({ chainText: s.chainText, assignedTo: s.assignedTo, flowContext: s.flowContext }));
}

describe('scanProject (Luxon fixtures)', () => {
  const sites = scanProject({ rootDir: FIXTURES_DIR });

  it('finds exactly one usage site per file for the simple cases, in source order', () => {
    expect(sitesForFile(sites, '01-basic-now.ts')).toEqual([
      {
        chainText: "DateTime.now().toISODate()",
        assignedTo: undefined,
        flowContext: ['returned'],
      },
    ]);

    expect(sitesForFile(sites, '03-chained-format.ts')).toEqual([
      {
        chainText: "DateTime.now().plus({ days: 7 }).toFormat('yyyy-MM-dd')",
        assignedTo: undefined,
        flowContext: ['returned'],
      },
    ]);

    expect(sitesForFile(sites, '07-stored-on-object.ts')).toEqual([
      {
        chainText: 'DateTime.now()',
        assignedTo: 'createdAt',
        flowContext: ['stored-on-object'],
      },
    ]);
  });

  it('tags both sides of a comparison with compared-to', () => {
    expect(sitesForFile(sites, '02-parse-and-compare.ts')).toEqual([
      {
        chainText: 'DateTime.fromISO(dateStr)',
        assignedTo: 'parsed',
        flowContext: ['compared-to:today'],
      },
      {
        chainText: 'DateTime.now()',
        assignedTo: 'today',
        flowContext: ['compared-to:parsed'],
      },
    ]);
  });

  it('detects timezone calls and spawns a new usage site for a chained call on the assigned variable', () => {
    expect(sitesForFile(sites, '04-timezone.ts')).toEqual([
      {
        chainText: "DateTime.fromISO(isoDate).setZone('Asia/Tokyo')",
        assignedTo: 'zoned',
        flowContext: ['chained-call:toISO', 'timezone-arg:present'],
      },
      {
        chainText: 'zoned.toISO()',
        assignedTo: undefined,
        flowContext: ['returned'],
      },
    ]);
  });

  it('climbs a trailing property access after a call, and tags passed-to for arguments', () => {
    expect(sitesForFile(sites, '05-diff-duration.ts')).toEqual([
      {
        chainText: 'DateTime.fromISO(a)',
        assignedTo: 'start',
        flowContext: ['passed-to:end.diff'],
      },
      {
        chainText: 'DateTime.fromISO(b)',
        assignedTo: 'end',
        flowContext: ['chained-call:diff'],
      },
      {
        chainText: "end.diff(start, 'days').days",
        assignedTo: undefined,
        flowContext: ['returned'],
      },
    ]);
  });

  it('follows a reassigned immutable-style variable across multiple statements', () => {
    expect(sitesForFile(sites, '06-reassignment.ts')).toEqual([
      {
        chainText: 'DateTime.now()',
        assignedTo: 'dt',
        flowContext: ['chained-call:plus', 'chained-call:setZone', 'chained-call:toISO'],
      },
      {
        chainText: 'dt.plus({ days: 1 })',
        assignedTo: 'dt',
        flowContext: ['chained-call:setZone', 'chained-call:toISO'],
      },
      {
        chainText: "dt.setZone('utc')",
        assignedTo: 'dt',
        flowContext: ['chained-call:plus', 'chained-call:toISO', 'timezone-arg:present'],
      },
      {
        chainText: 'dt.toISO()',
        assignedTo: undefined,
        flowContext: ['returned'],
      },
    ]);
  });

  it('produces a stable id derived from file + range', () => {
    for (const site of sites) {
      expect(site.id).toMatch(/^[0-9a-f]{12}$/);
      expect(site.range.end - site.range.start).toBe(site.chainText.length);
      expect(site.library).toBe('luxon');
    }
  });
});
