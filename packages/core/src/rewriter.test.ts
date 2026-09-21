import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { parseCallChain, runRewriter } from './rewriter.js';
import { scanProject } from './scanner.js';
import type { Classification, LibraryAdapter } from './types.js';

describe('parseCallChain', () => {
  function chainRootFor(source: string) {
    const project = new Project({ useInMemoryFileSystem: true });
    const file = project.createSourceFile('test.ts', source);
    // The scanned chain root is always the top-level expression of the return statement here.
    const returnStatement = file.getDescendantsOfKind(SyntaxKind.ReturnStatement)[0]!;
    return returnStatement.getExpressionOrThrow();
  }

  it('decomposes a multi-link chain into an ordered flat link list', () => {
    const node = chainRootFor(
      "function f() { return DateTime.fromISO(isoDate).setZone('Asia/Tokyo'); }",
    );
    const chain = parseCallChain('site-1', node);
    expect(chain.rootText).toBe('DateTime');
    expect(chain.links).toEqual([
      { method: 'fromISO', args: ['isoDate'] },
      { method: 'setZone', args: ["'Asia/Tokyo'"] },
    ]);
  });

  it('captures a trailing bare property access as a no-args link', () => {
    const node = chainRootFor("function f() { return end.diff(start, 'days').days; }");
    const chain = parseCallChain('site-1', node);
    expect(chain.rootText).toBe('end');
    expect(chain.links).toEqual([
      { method: 'diff', args: ['start', "'days'"] },
      { method: 'days', args: [] },
    ]);
  });

  it('handles a bare root with no chain at all', () => {
    const node = chainRootFor('function f() { return dt; }');
    const chain = parseCallChain('site-1', node);
    expect(chain.rootText).toBe('dt');
    expect(chain.links).toEqual([]);
  });
});

describe('runRewriter (mechanics, via a fake adapter)', () => {
  const fakeAdapter: LibraryAdapter = {
    libraryName: 'luxon',
    mutatesInPlace: false,
    formatTokenDialect: 'none',
    mapUsageSite(chain, classification) {
      if (classification.guess === 'AMBIGUOUS') {
        return { type: 'manual-review', usageSiteId: chain.usageSiteId, reason: 'test: ambiguous' };
      }
      return {
        type: 'rewrite',
        usageSiteId: chain.usageSiteId,
        newText: 'FAKE_NOW()',
        requiresTemporalImport: true,
      };
    },
  };

  function withTempDir(files: Record<string, string>, run: (dir: string) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), 'temporal-migrate-rewriter-test-'));
    try {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(dir, name), content, 'utf-8');
      }
      run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rewrites every reference, swaps the import, and applies right-to-left without corrupting offsets', () => {
    withTempDir(
      {
        'sampleA.ts': [
          "import { DateTime } from 'luxon';",
          '',
          'export function first(): number {',
          '  const a = DateTime.now();',
          '  const b = DateTime.now();',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        const sites = scanProject({ rootDir: dir });
        expect(sites).toHaveLength(2);

        const classifications: Classification[] = sites.map((s) => ({
          usageSiteId: s.id,
          guess: 'Instant',
          confidence: 'high',
          reason: 'test',
        }));

        const result = runRewriter({ rootDir: dir, sites, classifications, adapter: fakeAdapter });

        expect(result.manualReviewFlags).toHaveLength(0);
        expect(result.fileDiffs).toHaveLength(1);
        const [fileDiff] = result.fileDiffs;
        expect(fileDiff.rewrittenSiteIds).toHaveLength(2);
        expect(fileDiff.diff).toContain('FAKE_NOW()');
        // The luxon import is removed (shows up only as a deleted "-" line) and never re-added.
        expect(fileDiff.diff).toContain("-import { DateTime } from 'luxon';");
        expect(fileDiff.diff).not.toMatch(/^\+.*from 'luxon'/m);
        expect(fileDiff.diff).toMatch(/^\+.*from "temporal-polyfill"/m);
      },
    );
  });

  it('produces no FileDiff for a file whose only site is AMBIGUOUS, and reports it as manual review', () => {
    withTempDir(
      {
        'sampleB.ts': [
          "import { DateTime } from 'luxon';",
          '',
          'export function second(): number {',
          '  const c = DateTime.now();',
          '  return 2;',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        const sites = scanProject({ rootDir: dir });
        expect(sites).toHaveLength(1);

        const classifications: Classification[] = sites.map((s) => ({
          usageSiteId: s.id,
          guess: 'AMBIGUOUS',
          confidence: 'low',
          reason: 'test: no signal',
        }));

        const result = runRewriter({ rootDir: dir, sites, classifications, adapter: fakeAdapter });

        expect(result.fileDiffs).toHaveLength(0);
        expect(result.manualReviewFlags).toHaveLength(1);
        expect(result.manualReviewFlags[0].usageSiteId).toBe(sites[0].id);
      },
    );
  });

  it('keeps the source-library import when some references in the file remain unrewritten', () => {
    withTempDir(
      {
        'sampleC.ts': [
          "import { DateTime } from 'luxon';",
          '',
          'export function third(): number {',
          '  const a = DateTime.now();',
          '  const b = DateTime.now();',
          '  return 1;',
          '}',
          '',
        ].join('\n'),
      },
      (dir) => {
        const sites = scanProject({ rootDir: dir });
        expect(sites).toHaveLength(2);

        // Only rewrite the first site; leave the second AMBIGUOUS.
        const classifications: Classification[] = sites.map((s, i) => ({
          usageSiteId: s.id,
          guess: i === 0 ? 'Instant' : 'AMBIGUOUS',
          confidence: i === 0 ? 'high' : 'low',
          reason: 'test',
        }));

        const result = runRewriter({ rootDir: dir, sites, classifications, adapter: fakeAdapter });

        expect(result.fileDiffs).toHaveLength(1);
        expect(result.manualReviewFlags).toHaveLength(1);
        // DateTime is still referenced by the un-rewritten second site, so the import must stay.
        expect(result.fileDiffs[0].diff).toContain("from 'luxon'");
      },
    );
  });
});
