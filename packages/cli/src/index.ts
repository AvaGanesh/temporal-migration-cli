#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  classifyUsageSites,
  runRewriter,
  scanProject,
  summarizeUsageSites,
  type RewriteResult,
  type ScanSummary,
  type UsageSite,
} from '@temporal-migrate/core';
import { luxonAdapter } from '@temporal-migrate/adapter-luxon';

const program = new Command();

program
  .name('temporal-migrate')
  .description('Migrate a JS/TS codebase from Moment/date-fns/Day.js/Luxon to Temporal')
  .version('0.1.0');

program
  .command('scan')
  .description(
    'Scan a codebase for library usage sites (Module 1 only, no classification or rewriting)',
  )
  .argument('[path]', 'path to scan', '.')
  .option('--json <file>', 'write the UsageSite[] JSON report to this file')
  .action((targetPath: string, opts: { json?: string }) => {
    const usageSites = scanProject({ rootDir: targetPath });
    const summary = summarizeUsageSites(usageSites);
    printSummary(summary);

    if (opts.json) {
      writeFileSync(opts.json, JSON.stringify(usageSites, null, 2), 'utf-8');
      console.log(`\nWrote ${usageSites.length} usage site(s) to ${opts.json}`);
    }
  });

program
  .command('plan')
  .description(
    'Scan, classify, and propose Temporal rewrites as diffs (dry-run, Luxon only; nothing is written to disk)',
  )
  .argument('[path]', 'path to scan', '.')
  .option(
    '--json <file>',
    'write the full plan (diffs + manual-review reasons) as JSON to this file',
  )
  .action((targetPath: string, opts: { json?: string }) => {
    const usageSites = scanProject({ rootDir: targetPath });
    const classifications = classifyUsageSites(usageSites);
    const result = runRewriter({
      rootDir: targetPath,
      sites: usageSites,
      classifications,
      adapter: luxonAdapter,
    });

    printPlan(usageSites, result);

    if (opts.json) {
      const byId = new Map(usageSites.map((s) => [s.id, s]));
      const payload = {
        fileDiffs: result.fileDiffs,
        manualReview: result.manualReviewFlags.map((f) => ({
          ...f,
          file: byId.get(f.usageSiteId)?.file,
          chainText: byId.get(f.usageSiteId)?.chainText,
        })),
      };
      writeFileSync(opts.json, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`\nWrote plan to ${opts.json}`);
    }
  });

function printPlan(sites: UsageSite[], result: RewriteResult): void {
  const rewrittenCount = result.fileDiffs.reduce((n, f) => n + f.rewrittenSiteIds.length, 0);
  console.log(
    `Rewritten: ${rewrittenCount} usage site(s) across ${result.fileDiffs.length} file(s)`,
  );
  console.log(`Needs manual review: ${result.manualReviewFlags.length} usage site(s)`);

  for (const fileDiff of result.fileDiffs) {
    console.log(`\n--- ${fileDiff.file} ---`);
    console.log(fileDiff.diff);
  }

  if (result.manualReviewFlags.length > 0) {
    const byId = new Map(sites.map((s) => [s.id, s]));
    console.log('\nManual review needed:');
    for (const flag of result.manualReviewFlags) {
      const site = byId.get(flag.usageSiteId);
      console.log(`  ${site?.file ?? '(unknown file)'} :: ${site?.chainText ?? flag.usageSiteId}`);
      console.log(`    ${flag.reason}`);
    }
  }
}

function printSummary(summary: ScanSummary): void {
  console.log(`Total usage sites: ${summary.totalUsageSites}`);

  console.log('\nBy library:');
  for (const [library, count] of Object.entries(summary.byLibrary)) {
    console.log(`  ${library.padEnd(10)} ${count}`);
  }

  console.log('\nBy file:');
  for (const [file, count] of Object.entries(summary.byFile)) {
    console.log(`  ${count.toString().padStart(3)}  ${file}`);
  }
}

program.parse();
