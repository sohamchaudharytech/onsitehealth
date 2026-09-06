export function interpolate(s, progress, at) {
    const t = Math.max(0, Math.min(1, progress));
    const { lat: lat1, lng: lng1 } = s.origin;
    const { lat: lat2, lng: lng2 } = s.destination;
    // perpendicular offset for a gentle road-like curve
    const dLat = lat2 - lat1;
    const dLng = lng2 - lng1;
    const len = Math.hypot(dLat, dLng) || 1;
    const arc = Math.sin(t * Math.PI) * 0.12; // peak 12% of route length
    const lat = lat1 + dLat * t + (-dLng / len) * arc * len * 0.5;
    const lng = lng1 + dLng * t + (dLat / len) * arc * len * 0.5;
    return { lat, lng, at };
}
/** Advance one shipment by one tick; returns the new progress (0..1+). */
export function advanceProgress(s, opts) {
    const jitter = 0.75 + Math.random() * 0.5; // ±25%
    const step = opts.speedPerTick * jitter;
    const last = s.route[s.route.length - 1];
    const done = fractionAlong(s, last);
    return Math.min(1.0001, done + step);
}
/** How far along the straight line the last ping is (0..1). */
export function fractionAlong(s, p) {
    const dLat = s.destination.lat - s.origin.lat;
    const dLng = s.destination.lng - s.origin.lng;
    const len2 = dLat * dLat + dLng * dLng;
    if (len2 === 0)
        return 1;
    const t = ((p.lat - s.origin.lat) * dLat + (p.lng - s.origin.lng) * dLng) / len2;
    return Math.max(0, Math.min(1, t));
}
/** Estimated minutes to arrival at current speed (null when not moving). */
export function etaMinutes(s, opts) {
    if (s.status !== 'IN_TRANSIT')
        return null;
    const last = s.route[s.route.length - 1];
    const remaining = 1 - fractionAlong(s, last);
    if (remaining <= 0)
        return 0;
    const ticks = remaining / opts.speedPerTick;
    return Math.round((ticks * opts.tickMs) / 60000);
}
//# sourceMappingURL=sim.js.map