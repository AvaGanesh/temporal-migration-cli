# temporal-migrate

A CLI that scans a JS/TS codebase for usages of **Moment**, **date-fns**, **Day.js**, and
**Luxon**, classifies each usage by the `Temporal` type it should become, and (eventually)
rewrites the call sites, injects a polyfill, and validates the result against a battery of
date edge cases before anything is applied. Every run produces a diff + report — the tool
never auto-commits a rewrite.

> **Status: early build.** Only the Scanner and Classifier exist so far, and only for Luxon.
> See [Build status](#build-status) below for what's implemented vs. planned.

## Why

`Temporal` is landing as the modern date/time API, and most JS/TS codebases have years of
accumulated Moment/date-fns/Day.js/Luxon call sites. Migrating by hand is tedious and
risky — this tool automates the mechanical parts (finding usages, guessing intent, rewriting)
while treating anything ambiguous as a hard stop for manual review rather than a silent guess.

## Build status

| Module                                 | Status         | Notes                                                                                                                         |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1. Scanner                             | ✅ Luxon only  | Finds import bindings, climbs full call chains into one `UsageSite`, follows reassigned variables, tags `flowContext` signals |
| 2. Classifier                          | ✅ Luxon only  | Heuristic rule set: `UsageSite[] → Classification[]`, everything not confidently matched is flagged `AMBIGUOUS`               |
| 3. Adapter system + Rewriter           | ⏳ not started | Per-library mapping tables + AST rewrite, diff output                                                                         |
| 4. Validation harness                  | ⏳ not started | Edge-case battery (DST, leap years, month/year boundaries, etc.) comparing old vs. new behavior                               |
| 5. Polyfill & format-token translation | ⏳ not started |                                                                                                                               |
| 6. date-fns / Day.js / Moment adapters | ⏳ not started | Luxon first because its API surface is simplest; Moment last because of in-place mutation                                     |

Full milestone-by-milestone plan lives in project history/planning docs, not checked into
the repo.

## Packages

```
temporal-migrate/
├── packages/
│   ├── core/    # scanner.ts, classifier.ts, shared types — the library-agnostic engine
│   └── cli/     # commander-based CLI wrapping core (`temporal-migrate scan`)
├── fixtures/
│   └── luxon/   # sample source files USING Luxon — input for the scanner/classifier tests,
│                # not tests themselves (packages/core/src/*.test.ts are the actual tests)
└── .github/workflows/ci.yml
```

`core` is deliberately kept library-agnostic: adding a 5th source library later means adding
a new `packages/adapter-*` package and a `fixtures/<library>/` set, not touching the scanner
or classifier internals.

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
```

Prints a per-library/per-file usage summary and optionally writes the raw `UsageSite[]` JSON.
Only Modules 1 (Scanner) are wired into the CLI so far — `plan`/`apply` commands land with
the Rewriter in a later milestone.

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
