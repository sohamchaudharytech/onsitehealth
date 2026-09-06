/**
 * In-memory shipment store. Single-writer, event-sourced-ish: every mutation
 * appends to the hash-chained ledger (kept in index.ts) and broadcasts a
 * live event. Storage is in-memory by design (same honest caveat as the
 * clinical services — MongoDB is a later phase).
 */
export class ShipmentStore {
    shipments = new Map();
    byOrderCode = new Map();
    seq = 0;
    create(input) {
        const shipmentId = `shp-${String(++this.seq).padStart(4, '0')}`;
        const now = new Date().toISOString();
        const shipment = {
            shipmentId,
            orderCode: input.orderCode,
            drugName: input.drugName,
            quantity: input.quantity,
            coldChain: input.coldChain,
            status: 'NOT_SENT',
            origin: input.origin,
            destination: input.destination,
            route: [{ ...input.origin, at: now }],
            deliveredAt: null,
            createdAt: now,
            createdBy: input.createdBy,
            lastEvent: null,
        };
        this.shipments.set(shipmentId, shipment);
        this.byOrderCode.set(input.orderCode, shipmentId);
        return shipment;
    }
    get(shipmentId) {
        return this.shipments.get(shipmentId) ?? null;
    }
    getByOrderCode(orderCode) {
        const id = this.byOrderCode.get(orderCode);
        return id ? (this.shipments.get(id) ?? null) : null;
    }
    list(filter) {
        const all = [...this.shipments.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return filter?.status ? all.filter((s) => s.status === filter.status) : all;
    }
    /** Append a GPS point to the breadcrumb trail. */
    appendLocation(shipmentId, point) {
        const s = this.shipments.get(shipmentId);
        if (!s)
            return null;
        s.route.push(point);
        return s;
    }
    /** Legal transitions: NOT_SENT → IN_TRANSIT → DELIVERED (no going back). */
    static canTransition(from, to) {
        if (from === to)
            return false;
        if (from === 'NOT_SENT')
            return to === 'IN_TRANSIT';
        if (from === 'IN_TRANSIT')
            return to === 'DELIVERED';
        return false; // DELIVERED is terminal
    }
    /**
     * Transition status. Returns the updated shipment, or null if the
     * transition is illegal (e.g. DELIVERED → IN_TRANSIT).
     */
    transition(shipmentId, to, by) {
        const s = this.shipments.get(shipmentId);
        if (!s)
            return null;
        if (!ShipmentStore.canTransition(s.status, to))
            return null;
        const from = s.status;
        const now = new Date().toISOString();
        s.status = to;
        s.lastEvent = { from, to, at: now, by: by?.username ?? 'system' };
        if (to === 'DELIVERED') {
            s.deliveredAt = now;
            // snap the final breadcrumb to the destination
            s.route.push({ ...s.destination, at: now });
        }
        return { shipment: s, from };
    }
    /** Current position = last breadcrumb (null before any movement). */
    static currentPosition(s) {
        return s.route.length ? s.route[s.route.length - 1] : null;
    }
    /** % of the way from origin to destination (0..1, straight-line). */
    static progress(s) {
        if (s.status === 'DELIVERED')
            return 1;
        if (s.status === 'NOT_SENT')
            return 0;
        const p = ShipmentStore.currentPosition(s);
        if (!p)
            return 0;
        const total = haversine(s.origin, s.destination);
        if (total === 0)
            return 1;
        const done = haversine(s.origin, p);
        return Math.max(0, Math.min(1, done / total));
    }
}
/** Great-circle distance in km. */
export function haversine(a, b) {
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const la1 = (a.lat * Math.PI) / 180;
    const la2 = (b.lat * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}
//# sourceMappingURL=store.js.map