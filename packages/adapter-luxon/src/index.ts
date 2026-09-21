/**
 * Module 3 — Luxon adapter (Milestone 3 scope).
 *
 * Pure lookup-table logic, no ts-morph/AST access: given a ParsedCallChain
 * (from core's Rewriter) and a confident Classification, produces either a
 * RewriteRule (the exact Temporal-equivalent text) or a ManualReviewFlag.
 *
 * Known limitations, deliberately left as manual-review or documented risk
 * rather than guessed at — the plan's Milestone 4 validation harness exists
 * specifically to catch what mechanical text mapping can't:
 *  - `Interval` has no direct Temporal equivalent.
 *  - Format/serialization methods (.toFormat, .toISO, ...) need format-token
 *    translation, which is Module 5 (Milestone 7), not implemented yet.
 *  - `.diff(other, 'unit')` is only rewritten when immediately followed by a
 *    bare `.unit` accessor matching the same unit (the exact shape our
 *    fixtures use); anything else is flagged rather than guessed.
 *  - `DateTime.fromISO(s).setZone(tz)` rewrites to
 *    `Temporal.ZonedDateTime.from(s).withTimeZone(tz)`, but Luxon's
 *    `setZone` re-displays an already-absolute instant in a new zone,
 *    while `Temporal.ZonedDateTime.from` requires `s` to already carry a
 *    UTC offset/bracketed zone. If it doesn't, this throws at runtime
 *    instead of silently misbehaving — a real but visible risk, left for
 *    the validation harness to catch systematically.
 */
import type {
  CallChainLink,
  Classification,
  LibraryAdapter,
  MappingResult,
  ParsedCallChain,
  TemporalType,
} from '@temporal-migrate/core';

function rewrite(
  usageSiteId: string,
  newText: string,
  requiresTemporalImport: boolean,
): MappingResult {
  return { type: 'rewrite', usageSiteId, newText, requiresTemporalImport };
}

function manualReview(usageSiteId: string, reason: string): MappingResult {
  return { type: 'manual-review', usageSiteId, reason };
}

const NOW_CONSTRUCTOR: Partial<Record<TemporalType, string>> = {
  Instant: 'Temporal.Now.instant()',
  ZonedDateTime: 'Temporal.Now.zonedDateTimeISO()',
  PlainDate: 'Temporal.Now.plainDateISO()',
  PlainDateTime: 'Temporal.Now.plainDateTimeISO()',
  PlainTime: 'Temporal.Now.plainTimeISO()',
};

const FROM_CONSTRUCTOR: Partial<Record<TemporalType, string>> = {
  Instant: 'Temporal.Instant.from',
  ZonedDateTime: 'Temporal.ZonedDateTime.from',
  PlainDate: 'Temporal.PlainDate.from',
  PlainDateTime: 'Temporal.PlainDateTime.from',
  PlainTime: 'Temporal.PlainTime.from',
};

// Bare property getters whose name is identical on Luxon's DateTime and on
// the various Temporal types — these never need rewriting, only the value
// they're read from does (that value's own origin call site is what gets
// rewritten, independently).
const PASSTHROUGH_GETTERS = new Set([
  'year',
  'month',
  'day',
  'hour',
  'minute',
  'second',
  'millisecond',
  'weekday',
]);

// Format/serialization methods: need format-token translation (Module 5 /
// Milestone 7), not implemented yet — flagged rather than guessed.
const FORMAT_METHODS = new Set([
  'toFormat',
  'toISO',
  'toISODate',
  'toISOTime',
  'toISOWeekDate',
  'toLocaleString',
  'toHTTP',
  'toRFC2822',
  'toSQL',
  'toString',
]);

const METHOD_MAP: Record<string, (args: string[]) => string> = {
  plus: (args) => `add(${args.join(', ')})`,
  minus: (args) => `subtract(${args.join(', ')})`,
  setZone: (args) => `withTimeZone(${args.join(', ')})`,
};

function stripQuotes(text: string): string {
  return text.replace(/^['"]|['"]$/g, '');
}

function buildRewrite(
  usageSiteId: string,
  rootText: string,
  links: CallChainLink[],
): MappingResult {
  let text = rootText;
  let i = 0;

  while (i < links.length) {
    const link = links[i];

    if (link.method === 'diff') {
      const [target, unitArgRaw] = link.args;
      const unit = unitArgRaw ? stripQuotes(unitArgRaw) : undefined;
      const next = links[i + 1];
      if (target && unit && next && next.args.length === 0 && next.method === unit) {
        text += `.since(${target}).total(${unitArgRaw})`;
        i += 2;
        continue;
      }
      return manualReview(
        usageSiteId,
        '.diff(...) is not immediately followed by a matching bare unit accessor (e.g. .diff(x, "days").days) — needs manual review',
      );
    }

    if (link.args.length === 0 && PASSTHROUGH_GETTERS.has(link.method)) {
      text += `.${link.method}`;
      i += 1;
      continue;
    }

    const mapper = METHOD_MAP[link.method];
    if (!mapper) {
      return manualReview(usageSiteId, `.${link.method}(...) has no Luxon -> Temporal mapping yet`);
    }
    text += `.${mapper(link.args)}`;
    i += 1;
  }

  // Only the root constructor (Temporal.Now.xyz()/Temporal.Xyz.from(...))
  // ever introduces a `Temporal.` reference; the method links appended
  // above (add/subtract/withTimeZone/since+total/passthrough getters)
  // never do, so a plain-variable rewrite like `first.year` or
  // `end.since(start).total('days')` correctly needs no import.
  return rewrite(usageSiteId, text, text.includes('Temporal.'));
}

export const luxonAdapter: LibraryAdapter = {
  libraryName: 'luxon',
  mutatesInPlace: false,
  formatTokenDialect: 'luxon',

  mapUsageSite(chain: ParsedCallChain, classification: Classification): MappingResult {
    const guess = classification.guess;
    if (guess === 'AMBIGUOUS') {
      // Precondition violated: the Rewriter must filter AMBIGUOUS sites out
      // before ever calling an adapter.
      return manualReview(chain.usageSiteId, 'classifier marked this usage site AMBIGUOUS');
    }

    if (chain.rootText === 'Interval') {
      return manualReview(
        chain.usageSiteId,
        'Interval has no direct Temporal equivalent — needs manual review',
      );
    }

    const formatLink = chain.links.find((l) => FORMAT_METHODS.has(l.method));
    if (formatLink) {
      return manualReview(
        chain.usageSiteId,
        `.${formatLink.method}(...) needs format-token translation, not implemented until Module 5`,
      );
    }

    if (chain.rootText === 'DateTime') {
      const [firstLink, ...rest] = chain.links;
      if (!firstLink) {
        return manualReview(chain.usageSiteId, 'DateTime referenced with no constructor call');
      }
      if (firstLink.method === 'now') {
        const ctor = NOW_CONSTRUCTOR[guess];
        if (!ctor) {
          return manualReview(chain.usageSiteId, `no Temporal.Now constructor mapped for ${guess}`);
        }
        return buildRewrite(chain.usageSiteId, ctor, rest);
      }
      if (firstLink.method === 'fromISO') {
        const ctor = FROM_CONSTRUCTOR[guess];
        if (!ctor) {
          return manualReview(
            chain.usageSiteId,
            `no Temporal .from constructor mapped for ${guess}`,
          );
        }
        const newRoot = `${ctor}(${firstLink.args.join(', ')})`;
        return buildRewrite(chain.usageSiteId, newRoot, rest);
      }
      return manualReview(
        chain.usageSiteId,
        `DateTime.${firstLink.method}(...) has no seed mapping yet`,
      );
    }

    // A plain variable/expression: assume it already holds a Temporal value
    // from its own (independently rewritten) origin site, and translate
    // only the remaining method links.
    return buildRewrite(chain.usageSiteId, chain.rootText, chain.links);
  },
};
