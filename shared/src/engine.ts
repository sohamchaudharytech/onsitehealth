import type { AlertResult, ClinicalOrder, ReferenceSnapshot, Severity } from './types.js';

/**
 * The rule evaluator is a black box: evaluate(order, referenceSnapshot) ->
 * {fires, severity, ruleId}. The consistency mechanism never inspects rule
 * content — this toy drug-interaction domain is purely a vehicle.
 */
export interface RuleEngine {
  evaluate(order: ClinicalOrder, snapshot: ReferenceSnapshot): {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
  };
}

const SEVERITY_ORDER: Record<Severity, number> = {
  NONE: 0,
  LOW: 1,
  MODERATE: 2,
  SEVERE: 3,
  CRITICAL: 4,
};

export function severityRank(s: Severity): number {
  return SEVERITY_ORDER[s];
}

/**
 * Toy domain: drug-pair interaction severity. A rule payload looks like:
 *   { drugA: "warfarin", drugB: "aspirin", severity: "SEVERE", note: "..." }
 * An order's details look like:
 *   { drugs: ["warfarin", "aspirin"] }
 */
export class DrugInteractionEngine implements RuleEngine {
  evaluate(order: ClinicalOrder, snapshot: ReferenceSnapshot) {
    const drugs = Array.isArray(order.details.drugs)
      ? (order.details.drugs as string[]).map((d) => String(d).toLowerCase())
      : [];
    let best: { fires: boolean; severity: Severity; ruleId: string | null } = {
      fires: false,
      severity: 'NONE',
      ruleId: null,
    };
    for (const rule of Object.values(snapshot.rules)) {
      const p = rule.payload as { drugA?: string; drugB?: string; severity?: string };
      if (!p.drugA || !p.drugB) continue;
      const a = String(p.drugA).toLowerCase();
      const b = String(p.drugB).toLowerCase();
      const hasA = drugs.includes(a);
      const hasB = drugs.includes(b);
      if (hasA && hasB) {
        const sev = (p.severity as Severity) ?? 'MODERATE';
        if (severityRank(sev) > severityRank(best.severity)) {
          best = { fires: true, severity: sev, ruleId: rule.ruleId };
        }
      }
    }
    return best;
  }
}

/** Most conservative of two results: never suppress, only ever escalate. */
export function mostConservative(
  a: { fires: boolean; severity: Severity; ruleId: string | null },
  b: { fires: boolean; severity: Severity; ruleId: string | null },
): { fires: boolean; severity: Severity; ruleId: string | null } {
  if (a.fires && b.fires) {
    return severityRank(a.severity) >= severityRank(b.severity) ? a : b;
  }
  if (a.fires) return a;
  if (b.fires) return b;
  return a;
}

export function resultsEqual(
  a: { fires: boolean; severity: Severity; ruleId: string | null },
  b: { fires: boolean; severity: Severity; ruleId: string | null },
): boolean {
  return a.fires === b.fires && a.severity === b.severity && a.ruleId === b.ruleId;
}

export type { AlertResult };
