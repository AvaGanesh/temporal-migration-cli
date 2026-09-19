import type { ScanSummary, UsageSite } from './types.js';

export function summarizeUsageSites(sites: UsageSite[]): ScanSummary {
  const byLibrary: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  for (const site of sites) {
    byLibrary[site.library] = (byLibrary[site.library] ?? 0) + 1;
    byFile[site.file] = (byFile[site.file] ?? 0) + 1;
  }
  return {
    totalUsageSites: sites.length,
    byLibrary,
    byFile,
  };
}
