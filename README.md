# temporal-migrate

A CLI that scans a JS/TS codebase for usages of **Moment**, **date-fns**, **Day.js**, and
**Luxon**, classifies each usage by the `Temporal` type it should become, and (eventually)
rewrites the call sites, injects a polyfill, and validates the result against a battery of
date edge cases before anything is applied. Every run produces a diff + report — the tool
never auto-commits a rewrite.

> **Status: early build.** Scanner, Classifier, and Adapter+Rewriter exist so far, and only for
> Luxon. See [Build status](#build-status) below for what's implemented vs. planned, including
> known correctness gaps found by hand-checking the Rewriter's output.

## Why

`Temporal` is landing as the modern date/time API, and most JS/TS codebases have years of
accumulated Moment/date-fns/Day.js/Luxon call sites. Migrating by hand is tedious and
risky — this tool automates the mechanical parts (finding usages, guessing intent, rewriting)
while treating anything ambiguous as a hard stop for manual review rather than a silent guess.

## Build status

| Module                                 | Status         | Notes                                                                                                                                                            |
| -------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Scanner                             | ✅ Luxon only  | Finds import bindings, climbs full call chains into one `UsageSite`, follows reassigned variables, tags `flowContext` signals                                    |
| 2. Classifier                          | ✅ Luxon only  | Heuristic rule set: `UsageSite[] → Classification[]`, everything not confidently matched is flagged `AMBIGUOUS`                                                  |
| 3. Adapter system + Rewriter           | ✅ Luxon only  | `ParsedCallChain → RewriteRule \| ManualReviewFlag` lookup table + ts-morph rewrite, unified diff per file. Known gaps below — Milestone 4 exists to catch them. |
| 4. Validation harness                  | ⏳ not started | Edge-case battery (DST, leap years, month/year boundaries, etc.) comparing old vs. new behavior                                                                  |
| 5. Polyfill & format-token translation | ⏳ not started | Format/serialization methods (`.toFormat`, `.toISO`, ...) are flagged for manual review until this exists                                                        |
| 6. date-fns / Day.js / Moment adapters | ⏳ not started | Luxon first because its API surface is simplest; Moment last because of in-place mutation                                                                        |

Full milestone-by-milestone plan lives in project history/planning docs, not checked into
the repo.

### Known gaps in the Milestone 3 Rewriter (surfaced by hand-checking the fixture diffs)

- **Cross-site coherence isn't tracked.** A usage site can be confidently classified and
  rewritten even when the variable it operates on was left un-rewritten (`AMBIGUOUS`) at its
  own origin. Example: `fixtures/luxon/05-diff-duration.ts` rewrites
  `end.diff(start, 'days').days` → `end.since(start).total('days')`, but `start`/`end`'s own
  `DateTime.fromISO(...)` calls are `AMBIGUOUS` and stay untouched — so the rewritten line
  calls `.since()` on what is still a raw Luxon `DateTime` at runtime. The diff makes this
  visible (the unchanged Luxon declaration sits right next to the changed line), so a human
  reviewer is likely to catch it, but the tool doesn't flag it automatically yet.
- **`Temporal.Instant.from(...)` / `Temporal.ZonedDateTime.from(...)` assume an offset the
  source string may not have.** Both throw at runtime if the ISO string lacks a UTC
  offset/bracketed zone; Luxon's `fromISO`/`setZone` don't require one. This mainly affects the
  `Instant` (medium-confidence, comparison-based) and `ZonedDateTime` classifications.

Both are real, not hypothetical — see `fixtures/luxon/05-diff-duration.ts`,
`06-reassignment.ts`, `02-parse-and-compare.ts`, and `04-timezone.ts`. They're left as
documented risk rather than fixed now because catching exactly this class of drift
systematically is what Module 4 (Validation harness) is for.

## Packages

```
temporal-migrate/
├── packages/
│   ├── core/           # scanner.ts, classifier.ts, rewriter.ts, shared types — the
│   │                    # library-agnostic engine
│   ├── adapter-luxon/  # Luxon -> Temporal mapping table (LibraryAdapter implementation)
│   └── cli/            # commander-based CLI wrapping core + adapter-luxon
├── fixtures/
│   └── luxon/   # sample source files USING Luxon — input for the scanner/classifier/
│                # rewriter tests, not tests themselves (packages/*/src/*.test.ts are)
└── .github/workflows/ci.yml
```

`core` is deliberately kept library-agnostic: adding a 5th source library later means adding
a new `packages/adapter-*` package and a `fixtures/<library>/` set, not touching the scanner,
classifier, or rewriter internals.

## Getting started

Requires Node ≥20 and [pnpm](https://pnpm.io/) (`npm install -g pnpm` if you don't have it).

```bash
pnpm install
pnpm -r build
pnpm -r test
```

### CLI

```bash
# from the repo root, after building
node packages/cli/dist/index.js scan fixtures/luxon --json report.json
node packages/cli/dist/index.js plan fixtures/luxon --json plan.json
```

`scan` prints a per-library/per-file usage summary and optionally writes the raw
`UsageSite[]` JSON. `plan` runs the full scan → classify → rewrite pipeline and prints a
unified diff per file plus the manual-review list, as a dry run — it never writes to disk.
`apply` (actually writing the rewrite to disk, gated on validation) doesn't exist yet.

## Development

```bash
pnpm build          # tsc -b in every package
pnpm test           # vitest in every package
pnpm lint           # eslint .
pnpm lint:fix
pnpm format          # prettier --write .
pnpm format:check    # prettier --check . (what CI runs)
```

CI (`.github/workflows/ci.yml`) runs `install → format:check → lint → build → test` on every
push and PR to `main`.

## Non-goals (v1)

- No `js-joda` or third-party Day.js plugin ecosystem support beyond relative-time/timezone/UTC.
- No automatic rewriting of relative-time strings ("2 hours ago") — flagged for
  `Intl.RelativeTimeFormat`, not auto-migrated.
- No automatic migration of locale-dependent formatting beyond best-effort token translation.
- No React Native / non-Node runtime support (polyfill injection assumes Node or a bundler).
- The tool never writes files without an explicit `--apply`.
