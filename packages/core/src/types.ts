/**
 * Shared types produced by the Scanner (Module 1) and consumed by every
 * later phase (Classifier, Adapters, Rewriter).
 */

export type SourceLibrary = 'moment' | 'date-fns' | 'dayjs' | 'luxon';

export interface Range {
  start: number;
  end: number;
}

/**
 * A tagged, human-readable signal describing how the value produced by a
 * UsageSite is used elsewhere in the file. These are heuristic hints for
 * the Classifier (Module 2), not a precise dataflow graph.
 *
 * Known tag shapes:
 *   'compared-to:<text>'   - value is one side of a relational/equality comparison
 *   'passed-to:<callee>'   - value is passed as an argument to <callee>(...)
 *   'chained-call:<name>'  - a further library method is later called on the value
 *   'stored-on-object'     - value is placed into an object literal property
 *   'returned'             - value is directly returned (or is an arrow fn's concise body)
 *   'serialized-to-json'   - value is passed to JSON.stringify
 *   'timezone-arg:present' - the call chain itself includes a timezone-setting call/option
 */
export type FlowUse = string;

export interface UsageSite {
  /** Stable hash of file + range, used to correlate this site across phases. */
  id: string;
  library: SourceLibrary;
  file: string;
  range: Range;
  /** Full source text of the call chain, e.g. "DateTime.now().plus({days:7})". */
  chainText: string;
  /** Variable name this usage site's result is assigned/reassigned to, if any. */
  assignedTo?: string;
  flowContext: FlowUse[];
}

export interface ScanSummary {
  totalUsageSites: number;
  byLibrary: Record<string, number>;
  byFile: Record<string, number>;
}

/**
 * Module 2 — Classifier output types.
 */
export type TemporalType =
  'PlainDate' | 'PlainDateTime' | 'PlainTime' | 'ZonedDateTime' | 'Instant' | 'Duration';

export type Confidence = 'high' | 'medium' | 'low';

export interface Classification {
  usageSiteId: string;
  guess: TemporalType | 'AMBIGUOUS';
  confidence: Confidence;
  /** Human-readable, shown in the report for AMBIGUOUS cases. */
  reason: string;
}

/**
 * Module 3 — Adapter System output types, and Module 4 — Rewriter output types.
 */

export interface RewriteRule {
  type: 'rewrite';
  usageSiteId: string;
  newText: string;
  /** Whether newText references the global `Temporal` object. */
  requiresTemporalImport: boolean;
}

export interface ManualReviewFlag {
  type: 'manual-review';
  usageSiteId: string;
  reason: string;
}

export type MappingResult = RewriteRule | ManualReviewFlag;

/** One `.method(args)` or bare `.property` link in a call chain, in source order. */
export interface CallChainLink {
  method: string;
  /** Raw source text of each call argument; empty for a bare property access. */
  args: string[];
}

/** A library-agnostic, ts-morph-free view of a UsageSite's call chain. */
export interface ParsedCallChain {
  usageSiteId: string;
  /** Text of the chain's root expression, e.g. 'DateTime', 'Interval', or a variable name. */
  rootText: string;
  links: CallChainLink[];
}

export interface LibraryAdapter {
  libraryName: SourceLibrary;
  /** True if the source library's methods mutate the receiver in place (e.g. Moment). */
  mutatesInPlace: boolean;
  formatTokenDialect: 'moment' | 'date-fns' | 'luxon' | 'none';
  /**
   * Maps one parsed call chain to its Temporal equivalent, given the
   * Classifier's confident guess for it. The Rewriter never calls this for
   * an AMBIGUOUS classification — those are filtered out first.
   */
  mapUsageSite(chain: ParsedCallChain, classification: Classification): MappingResult;
}

export interface FileDiff {
  file: string;
  /** Unified diff text. */
  diff: string;
  rewrittenSiteIds: string[];
}

export interface RewriteResult {
  /** One entry per file that received at least one rewrite; files with zero rewrites are omitted. */
  fileDiffs: FileDiff[];
  manualReviewFlags: ManualReviewFlag[];
}
