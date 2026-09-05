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
export declare function severityRank(s: Severity): number;
/**
 * Toy domain: drug-pair interaction severity. A rule payload looks like:
 *   { drugA: "warfarin", drugB: "aspirin", severity: "SEVERE", note: "..." }
 * An order's details look like:
 *   { drugs: ["warfarin", "aspirin"] }
 */
export declare class DrugInteractionEngine implements RuleEngine {
    evaluate(order: ClinicalOrder, snapshot: ReferenceSnapshot): {
        fires: boolean;
        severity: Severity;
        ruleId: string | null;
    };
}
/** Most conservative of two results: never suppress, only ever escalate. */
export declare function mostConservative(a: {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
}, b: {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
}): {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
};
export declare function resultsEqual(a: {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
}, b: {
    fires: boolean;
    severity: Severity;
    ruleId: string | null;
}): boolean;
export type { AlertResult };
//# sourceMappingURL=engine.d.ts.map