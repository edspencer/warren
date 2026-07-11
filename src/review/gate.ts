// Severity gate + dedup + confidence filter (SPEC §3.8 step 6, module map: review/gate.ts).
//
// Pure functions over Finding[]. Given the raw (verified) findings, a minimum severity,
// and the set of already-posted fingerprints, return only the findings that should
// actually be posted:
//   1. drop findings below `minSeverity`
//   2. drop low-confidence / unverified findings (didn't survive the verify pass)
//   3. drop duplicates — fingerprint already posted, or repeated within this batch

import type { Finding, Severity } from "../types.js";
import { fingerprint } from "./fingerprint.js";

/** Severity ranking, high number = more severe. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  nit: 0,
};

/** Numeric rank for a severity (higher = more severe). */
export function severityRank(sev: Severity): number {
  return SEVERITY_RANK[sev];
}

/** True if `sev` is at or above the `min` threshold. */
export function meetsSeverity(sev: Severity, min: Severity): boolean {
  return SEVERITY_RANK[sev] >= SEVERITY_RANK[min];
}

/** Default minimum post-verify confidence; findings below this are dropped. */
export const DEFAULT_MIN_CONFIDENCE = 0.5;

export interface GateOptions {
  /** Findings with confidence below this are dropped. Default 0.5. */
  minConfidence?: number;
  /**
   * Drop findings whose `verified` flag is false (they were refuted / unsubstantiated
   * by the verify pass). Default true.
   */
  requireVerified?: boolean;
}

/** Resolve the fingerprint for a finding, computing it if not already stamped. */
function fpOf(f: Finding): string {
  return f.fingerprint && f.fingerprint.length > 0 ? f.fingerprint : fingerprint(f);
}

/**
 * Filter `findings` down to the ones that should be posted.
 *
 * @param findings  candidate findings (already verified by the pipeline)
 * @param minSeverity  minimum severity to post
 * @param postedFingerprints  fingerprints already posted in prior reviews (dedup)
 * @param opts  confidence / verification thresholds
 */
export function gateFindings(
  findings: Finding[],
  minSeverity: Severity,
  postedFingerprints: Iterable<string> = [],
  opts: GateOptions = {},
): Finding[] {
  const minConfidence = opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const requireVerified = opts.requireVerified ?? true;
  const posted = new Set<string>(postedFingerprints);
  const seenThisBatch = new Set<string>();
  const out: Finding[] = [];

  for (const f of findings) {
    // 1. severity threshold
    if (!meetsSeverity(f.severity, minSeverity)) continue;
    // 2. verification + confidence
    if (requireVerified && f.verified === false) continue;
    if (f.confidence < minConfidence) continue;
    // 3. dedup (against prior reviews and within this batch)
    const fp = fpOf(f);
    if (posted.has(fp) || seenThisBatch.has(fp)) continue;
    seenThisBatch.add(fp);
    out.push(fp === f.fingerprint ? f : { ...f, fingerprint: fp });
  }
  return out;
}
