import type { GeoPoint, Shipment } from './types.js';
/**
 * Real-time movement simulator: every tick, each IN_TRANSIT shipment advances
 * along its origin→destination path and emits a GPS ping. When a shipment
 * reaches its destination it is auto-delivered (courier scan). NOT_SENT
 * shipments sit at the depot; DELIVERED ones have arrived.
 *
 * The position is interpolated on a slight sinusoidal arc (roads curve), so
 * the trail on the map looks like a route, not a ruler line.
 */
export interface SimOptions {
    tickMs: number;
    /** fraction of the route covered per tick (jittered ±25%) */
    speedPerTick: number;
}
export declare function interpolate(s: Shipment, progress: number, at: string): GeoPoint;
/** Advance one shipment by one tick; returns the new progress (0..1+). */
export declare function advanceProgress(s: Shipment, opts: SimOptions): number;
/** How far along the straight line the last ping is (0..1). */
export declare function fractionAlong(s: Shipment, p: GeoPoint): number;
/** Estimated minutes to arrival at current speed (null when not moving). */
export declare function etaMinutes(s: Shipment, opts: SimOptions): number | null;
//# sourceMappingURL=sim.d.ts.map