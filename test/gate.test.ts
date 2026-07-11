import { describe, it, expect } from "vitest";
import type { Finding, Severity, FindingCategory } from "../src/types.js";
import { gateFindings, meetsSeverity, severityRank } from "../src/review/gate.js";
import { fingerprint } from "../src/review/fingerprint.js";

function mkFinding(over: Partial<Finding> = {}): Finding {
  const base: Finding = {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "high" as Severity,
    category: "bug" as FindingCategory,
    title: "Null deref",
    body: "explanation",
    confidence: 0.9,
    fingerprint: "",
    verified: true,
  };
  const merged = { ...base, ...over };
  if (!merged.fingerprint) merged.fingerprint = fingerprint(merged);
  return merged;
}

describe("severity helpers", () => {
  it("ranks severities in order", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(severityRank("high")).toBeGreaterThan(severityRank("medium"));
    expect(severityRank("medium")).toBeGreaterThan(severityRank("low"));
    expect(severityRank("low")).toBeGreaterThan(severityRank("nit"));
  });
  it("meetsSeverity is inclusive of the threshold", () => {
    expect(meetsSeverity("medium", "medium")).toBe(true);
    expect(meetsSeverity("high", "medium")).toBe(true);
    expect(meetsSeverity("low", "medium")).toBe(false);
  });
});

describe("gateFindings", () => {
  it("drops findings below the minimum severity", () => {
    const findings = [
      mkFinding({ severity: "critical", title: "A" }),
      mkFinding({ severity: "medium", title: "B" }),
      mkFinding({ severity: "low", title: "C" }),
      mkFinding({ severity: "nit", title: "D" }),
    ];
    const kept = gateFindings(findings, "medium");
    expect(kept.map((f) => f.title)).toEqual(["A", "B"]);
  });

  it("drops findings whose fingerprint was already posted", () => {
    const dup = mkFinding({ title: "Dup", path: "src/x.ts" });
    const fresh = mkFinding({ title: "Fresh", path: "src/y.ts" });
    const kept = gateFindings([dup, fresh], "low", [dup.fingerprint]);
    expect(kept.map((f) => f.title)).toEqual(["Fresh"]);
  });

  it("dedups repeated fingerprints within the same batch", () => {
    const a = mkFinding({ title: "Same", path: "src/z.ts" });
    const b = mkFinding({ title: "Same", path: "src/z.ts" }); // identical -> same fingerprint
    expect(a.fingerprint).toBe(b.fingerprint);
    const kept = gateFindings([a, b], "low");
    expect(kept).toHaveLength(1);
  });

  it("drops low-confidence and unverified findings", () => {
    const good = mkFinding({ title: "Good", path: "src/1.ts", confidence: 0.8, verified: true });
    const lowConf = mkFinding({ title: "LowConf", path: "src/2.ts", confidence: 0.2, verified: true });
    const refuted = mkFinding({ title: "Refuted", path: "src/3.ts", confidence: 0.9, verified: false });
    const kept = gateFindings([good, lowConf, refuted], "low");
    expect(kept.map((f) => f.title)).toEqual(["Good"]);
  });

  it("respects a custom minConfidence and requireVerified=false", () => {
    const f = mkFinding({ title: "Edge", path: "src/e.ts", confidence: 0.35, verified: false });
    expect(gateFindings([f], "low", [], { minConfidence: 0.3, requireVerified: false })).toHaveLength(1);
    expect(gateFindings([f], "low", [], { minConfidence: 0.4, requireVerified: false })).toHaveLength(0);
  });

  it("stamps a computed fingerprint onto findings missing one", () => {
    const f: Finding = { ...mkFinding(), fingerprint: "" }; // force an unstamped finding
    const kept = gateFindings([f], "low");
    expect(kept[0].fingerprint).toBe(fingerprint(f));
    expect(kept[0].fingerprint).not.toBe("");
  });
});
