import express from 'express';
import { type AlertResult } from '@hc/shared';
/**
 * In-process simulated hospital agents for scalability testing.
 *
 * A "simulated hospital" behaves exactly like a real site-agent over the
 * wire: an HTTP server with /internal/push, /internal/evaluate, and
 * watermark ACKs to the coordinator. Unlike real agents (separate OS
 * processes), hundreds can run inside the central service process — so
 * the admin can dial the fleet from 3 hospitals to 500+ and watch
 * fan-out, epoch gating, and consistency hold (or break) at scale.
 *
 * The central service is the single process allowed to host these; a
 * restart forgets them (site registrations persist via the store only if
 * re-seeded — acceptable for a scale-test tool).
 */
export interface SimSite {
    siteId: string;
    server: ReturnType<typeof express>;
    handle: import('http').Server;
    port: number;
}
export declare function startSimSite(siteId: string, port: number, deps: {
    push: (ruleVersion: Record<string, unknown>) => {
        isNew: boolean;
        watermark: number;
    };
    evaluate: (order: Record<string, unknown>, orderEpoch: number) => AlertResult;
}): Promise<SimSite>;
export declare function generateHospitalName(index: number): string;
export declare function generateRegion(index: number): string;
/** Index 0 = first generated doctor; name parts cycle deterministically. */
export declare function generateDoctorName(index: number): {
    fullName: string;
    first: string;
    last: string;
};
/** Human-memorable demo password for generated doctors (scalability testing, not production). */
export declare function generateDoctorPassword(): string;
/** Port range for simulated hospital agents (4201+). */
export declare function simPortFor(portOffset: number): number;
//# sourceMappingURL=simulate.d.ts.map