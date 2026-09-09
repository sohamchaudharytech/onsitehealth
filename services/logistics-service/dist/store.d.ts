import type { GeoPoint, Shipment, ShipmentStatus } from './types.js';
/**
 * In-memory shipment store. Single-writer, event-sourced-ish: every mutation
 * appends to the hash-chained ledger (kept in index.ts) and broadcasts a
 * live event. Storage is in-memory by design (same honest caveat as the
 * clinical services — MongoDB is a later phase).
 */
export declare class ShipmentStore {
    private shipments;
    private byOrderCode;
    private seq;
    snapshot(): {
        shipments: Shipment[];
        seq: number;
    };
    restore(snapshot: ReturnType<ShipmentStore['snapshot']>): void;
    create(input: {
        orderCode: string;
        drugName: string;
        quantity: number;
        coldChain: boolean;
        origin: {
            name: string;
            lat: number;
            lng: number;
        };
        destination: {
            name: string;
            lat: number;
            lng: number;
        };
        createdBy: {
            userId: string;
            username: string;
            role: string;
        } | null;
    }): Shipment;
    get(shipmentId: string): Shipment | null;
    getByOrderCode(orderCode: string): Shipment | null;
    list(filter?: {
        status?: ShipmentStatus;
    }): Shipment[];
    /** Append a GPS point to the breadcrumb trail. */
    appendLocation(shipmentId: string, point: GeoPoint): Shipment | null;
    /** Legal transitions: NOT_SENT → IN_TRANSIT → DELIVERED (no going back). */
    static canTransition(from: ShipmentStatus, to: ShipmentStatus): boolean;
    /**
     * Transition status. Returns the updated shipment, or null if the
     * transition is illegal (e.g. DELIVERED → IN_TRANSIT).
     */
    transition(shipmentId: string, to: ShipmentStatus, by: {
        userId: string;
        username: string;
        role: string;
    } | null): {
        shipment: Shipment;
        from: ShipmentStatus;
    } | null;
    /** Current position = last breadcrumb (null before any movement). */
    static currentPosition(s: Shipment): GeoPoint | null;
    /** % of the way from origin to destination (0..1, straight-line). */
    static progress(s: Shipment): number;
}
/** Great-circle distance in km. */
export declare function haversine(a: {
    lat: number;
    lng: number;
}, b: {
    lat: number;
    lng: number;
}): number;
//# sourceMappingURL=store.d.ts.map