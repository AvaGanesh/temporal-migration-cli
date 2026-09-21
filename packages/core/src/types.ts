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
