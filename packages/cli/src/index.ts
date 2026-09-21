#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { Command } from 'commander';
import { scanProject, summarizeUsageSites, type ScanSummary } from '@temporal-migrate/core';

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
