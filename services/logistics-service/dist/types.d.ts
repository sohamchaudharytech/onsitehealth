/** Lifecycle of a shipment. 'NOT_SENT' → 'IN_TRANSIT' → 'DELIVERED'. */
export type ShipmentStatus = 'NOT_SENT' | 'IN_TRANSIT' | 'DELIVERED';
/** One GPS ping in a shipment's breadcrumb trail. */
export interface GeoPoint {
    lat: number;
    lng: number;
    at: string;
}
/** A medicine/drug delivery tracked end-to-end. */
export interface Shipment {
    shipmentId: string;
    /** human-readable code, e.g. RX-2026-0001 */
    orderCode: string;
    /** what is being shipped */
    drugName: string;
    quantity: number;
    /** temperature-sensitive cargo flag (vaccines, insulin, …) */
    coldChain: boolean;
    status: ShipmentStatus;
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
    /** full breadcrumb trail (last point = current location) */
    route: GeoPoint[];
    /** set when status becomes DELIVERED */
    deliveredAt: string | null;
    createdAt: string;
    createdBy: {
        userId: string;
        username: string;
        role: string;
    } | null;
    /** last status change + who made it */
    lastEvent: {
        from: ShipmentStatus;
        to: ShipmentStatus;
        at: string;
        by: string;
    } | null;
}
/** Status change event for the live feed / audit trail. */
export interface ShipmentEvent {
    shipmentId: string;
    orderCode: string;
    drugName: string;
    from: ShipmentStatus | null;
    to: ShipmentStatus;
    at: string;
    by: {
        userId: string;
        username: string;
        role: string;
    } | null;
    /** where it happened (current position when the event fired) */
    location: {
        lat: number;
        lng: number;
    } | null;
}
/** Live event pushed over the WebSocket to the dashboard. */
export interface LogisticsLiveEvent {
    type: 'SHIPMENT_CREATED' | 'SHIPMENT_STATUS' | 'SHIPMENT_LOCATION' | 'LEDGER';
    data: Record<string, unknown>;
    ts: string;
}
//# sourceMappingURL=types.d.ts.map