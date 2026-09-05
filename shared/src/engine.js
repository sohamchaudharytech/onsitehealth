const SEVERITY_ORDER = {
    NONE: 0,
    LOW: 1,
    MODERATE: 2,
    SEVERE: 3,
    CRITICAL: 4,
};
export function severityRank(s) {
    return SEVERITY_ORDER[s];
}
/**
 * Toy domain: drug-pair interaction severity. A rule payload looks like:
 *   { drugA: "warfarin", drugB: "aspirin", severity: "SEVERE", note: "..." }
 * An order's details look like:
 *   { drugs: ["warfarin", "aspirin"] }
 */
export class DrugInteractionEngine {
    evaluate(order, snapshot) {
        const drugs = Array.isArray(order.details.drugs)
            ? order.details.drugs.map((d) => String(d).toLowerCase())
            : [];
        let best = {
            fires: false,
            severity: 'NONE',
            ruleId: null,
        };
        for (const rule of Object.values(snapshot.rules)) {
            const p = rule.payload;
            if (!p.drugA || !p.drugB)
                continue;
            const a = String(p.drugA).toLowerCase();
            const b = String(p.drugB).toLowerCase();
            const hasA = drugs.includes(a);
            const hasB = drugs.includes(b);
            if (hasA && hasB) {
                const sev = p.severity ?? 'MODERATE';
                if (severityRank(sev) > severityRank(best.severity)) {
                    best = { fires: true, severity: sev, ruleId: rule.ruleId };
                }
            }
        }
        return best;
    }
}
/** Most conservative of two results: never suppress, only ever escalate. */
export function mostConservative(a, b) {
    if (a.fires && b.fires) {
        return severityRank(a.severity) >= severityRank(b.severity) ? a : b;
    }
    if (a.fires)
        return a;
    if (b.fires)
        return b;
    return a;
}
export function resultsEqual(a, b) {
    return a.fires === b.fires && a.severity === b.severity && a.ruleId === b.ruleId;
}
//# sourceMappingURL=engine.js.map