import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

// ── Types mirroring the logistics-service API ────────────────────────────────

interface GeoPoint {
  lat: number;
  lng: number;
  at: string;
}

interface Place {
  name: string;
  lat: number;
  lng: number;
}

interface ShipmentView {
  shipmentId: string;
  orderCode: string;
  drugName: string;
  quantity: number;
  coldChain: boolean;
  status: 'NOT_SENT' | 'IN_TRANSIT' | 'DELIVERED';
  origin: Place;
  destination: Place;
  route: GeoPoint[];
  deliveredAt: string | null;
  createdAt: string;
  createdBy: { userId: string; username: string; role: string } | null;
  lastEvent: { from: string; to: string; at: string; by: string } | null;
  current: { lat: number; lng: number; at: string } | null;
  progress: number;
  etaMinutes: number | null;
  distanceKm: number;
  remainingKm: number | null;
  routeFraction: number;
}

interface LiveEventMsg {
  type: 'SHIPMENT_CREATED' | 'SHIPMENT_STATUS' | 'SHIPMENT_LOCATION' | 'LEDGER';
  data: Record<string, unknown>;
  ts: string;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  role: string;
  username: string;
}

// ── Session persistence + single-flight refresh (same pattern as the
//    clinical dashboard — concurrent 401s must share ONE refresh call or
//    token rotation trips theft detection and revokes the family) ────────────

const SESSION_KEY = 'hc-logistics-session';
let inflightRefresh: Promise<Session | null> | null = null;

function saveSession(s: Session | null): void {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch { /* private mode etc. */ }
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s?.accessToken || !s?.refreshToken || !s.role) return null;
    return s;
  } catch {
    return null;
  }
}

async function refreshSession(session: Session): Promise<Session | null> {
  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      try {
        const r = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refreshToken: session.refreshToken }),
        });
        if (!r.ok) return null;
        const next = await r.json();
        return {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken,
          role: next.role,
          username: next.username,
        } satisfies Session;
      } catch {
        return null;
      } finally {
        setTimeout(() => { inflightRefresh = null; }, 0);
      }
    })();
  }
  return inflightRefresh;
}

async function api(
  session: Session,
  setSession: (s: Session | null) => void,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  let res = await doFetch(session.accessToken);
  if (res.status === 401) {
    const next = await refreshSession(session);
    if (next) {
      setSession(next);
      res = await doFetch(next.accessToken);
    }
  }
  return res;
}

// ── Theme ────────────────────────────────────────────────────────────────────

type Theme = 'dark' | 'light';

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
    return t === 'light' ? 'light' : 'dark';
  });
  const toggle = () => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('hc-logistics-theme', next); } catch { /* ignore */ }
      return next;
    });
  };
  return [theme, toggle];
}

function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return (
    <button className="theme-toggle" onClick={toggle} aria-label="Toggle dark or light theme">
      {theme === 'dark' ? '☾ dark' : '☀ light'}
    </button>
  );
}

// ── Live map (SVG, no external tile dependency) ─────────────────────────────

const STATUS_COLOR: Record<ShipmentView['status'], string> = {
  NOT_SENT: '#d29922',
  IN_TRANSIT: '#58a6ff',
  DELIVERED: '#3fb950',
};

function LiveMap({
  shipments,
  selectedId,
  onSelect,
}: {
  shipments: ShipmentView[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const W = 800;
  const H = 460;
  const PAD = 40;

  // Fit all route points into the viewport (auto-zoom to active cargo).
  const bounds = useMemo(() => {
    const pts: Array<{ lat: number; lng: number }> = [];
    for (const s of shipments) {
      pts.push(s.origin, s.destination);
      for (const p of s.route) pts.push(p);
    }
    if (!pts.length) return { minLat: 18.8, maxLat: 19.3, minLng: 72.7, maxLng: 73.1 };
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of pts) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    }
    // padding so markers don't sit on the edge
    const dLat = Math.max(0.02, (maxLat - minLat) * 0.15);
    const dLng = Math.max(0.02, (maxLng - minLng) * 0.15);
    return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLng: minLng - dLng, maxLng: maxLng + dLng };
  }, [shipments]);

  const project = (lat: number, lng: number) => ({
    x: PAD + ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * (W - 2 * PAD),
    y: H - PAD - ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * (H - 2 * PAD),
  });

  return (
    <div className="map-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Live shipment map">
        {/* subtle grid to give the void some texture */}
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`h${i}`} x1={0} x2={W} y1={(i + 1) * (H / 10)} y2={(i + 1) * (H / 10)} stroke="var(--log-sep)" strokeWidth="1" />
        ))}
        {Array.from({ length: 15 }, (_, i) => (
          <line key={`v${i}`} y1={0} y2={H} x1={(i + 1) * (W / 16)} x2={(i + 1) * (W / 16)} stroke="var(--log-sep)" strokeWidth="1" />
        ))}

        {shipments.map((s) => {
          const o = project(s.origin.lat, s.origin.lng);
          const d = project(s.destination.lat, s.destination.lng);
          const path = s.route.map((p) => project(p.lat, p.lng));
          const cur = s.current ? project(s.current.lat, s.current.lng) : o;
          const selected = s.shipmentId === selectedId;
          return (
            <g key={s.shipmentId} onClick={() => onSelect(s.shipmentId)} style={{ cursor: 'pointer' }}>
              {/* breadcrumb trail */}
              {path.length > 1 && (
                <polyline
                  points={path.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={STATUS_COLOR[s.status]}
                  strokeOpacity={selected ? 0.9 : 0.45}
                  strokeWidth={selected ? 2.5 : 1.5}
                  strokeDasharray={s.status === 'DELIVERED' ? undefined : '4 3'}
                />
              )}
              {/* origin depot */}
              <rect x={o.x - 4} y={o.y - 4} width={8} height={8} fill="var(--muted)" rx={1} />
              {/* destination */}
              <circle cx={d.x} cy={d.y} r={5} fill="none" stroke={STATUS_COLOR[s.status]} strokeWidth={2} />
              {s.status === 'DELIVERED' && <circle cx={d.x} cy={d.y} r={2} fill={STATUS_COLOR.DELIVERED} />}
              {/* current position */}
              {s.status !== 'DELIVERED' && (
                <>
                  <circle cx={cur.x} cy={cur.y} r={selected ? 9 : 7} fill={STATUS_COLOR[s.status]} fillOpacity={0.25} />
                  <circle cx={cur.x} cy={cur.y} r={4} fill={STATUS_COLOR[s.status]} />
                  {s.coldChain && (
                    <text x={cur.x + 8} y={cur.y - 6} fontSize={11} fill="var(--accent)">❄</text>
                  )}
                </>
              )}
              <text x={o.x + 7} y={o.y - 6} fontSize={10} fill="var(--muted)">{s.origin.name.split(',')[0]}</text>
              <text x={d.x + 7} y={d.y + 12} fontSize={10} fill="var(--muted)">{s.destination.name.split(',')[0]}</text>
            </g>
          );
        })}
      </svg>
      <div className="map-legend">
        <span><span className="legend-dot" style={{ background: STATUS_COLOR.NOT_SENT }} />not sent</span>
        <span><span className="legend-dot" style={{ background: STATUS_COLOR.IN_TRANSIT }} />on the way</span>
        <span><span className="legend-dot" style={{ background: STATUS_COLOR.DELIVERED }} />delivered</span>
        <span className="muted">❄ cold chain</span>
      </div>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

const STATUS_CLASS: Record<ShipmentView['status'], string> = {
  NOT_SENT: 'not-sent',
  IN_TRANSIT: 'in-transit',
  DELIVERED: 'delivered',
};

const STATUS_LABEL: Record<ShipmentView['status'], string> = {
  NOT_SENT: 'NOT SENT',
  IN_TRANSIT: 'ON THE WAY',
  DELIVERED: 'DELIVERED',
};

// ── Login ─────────────────────────────────────────────────────────────────────

function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('admin123');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const body = await r.json();
      if (!r.ok) {
        setError(body.error ?? 'login failed');
        return;
      }
      onLogin(body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app" style={{ maxWidth: 420, paddingTop: 80 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ThemeToggle />
      </div>
      <h1>Medicine Logistics</h1>
      <div className="subtitle">Sign in to track drug deliveries in real time</div>
      <form className="panel" onSubmit={submit}>
        <h2>Sign in</h2>
        <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {error && <div className="err" style={{ fontSize: 13 }}>{error}</div>}
        </div>
        <div className="footer-note" style={{ marginTop: 12 }}>
          Demo accounts — admin/admin123 · dispatcher/dispatcher123 · driver/driver123 · auditor/auditor123 · viewer/viewer123
        </div>
      </form>
    </div>
  );
}

// ── New shipment form ─────────────────────────────────────────────────────────

const PRESETS: Array<{ label: string; origin: Place; destination: Place }> = [
  {
    label: 'Central Pharmacy → Fortis Mulund',
    origin: { name: 'Central Pharmacy, Mumbai', lat: 19.076, lng: 72.8777 },
    destination: { name: 'Fortis Hospital, Mulund', lat: 19.172, lng: 72.957 },
  },
  {
    label: 'Airport Cold Hub → KEM Parel',
    origin: { name: 'Airport Cold Hub', lat: 19.089, lng: 72.8656 },
    destination: { name: 'KEM Hospital, Parel', lat: 18.997, lng: 72.842 },
  },
  {
    label: 'Central Pharmacy → Nanavati Vile Parle',
    origin: { name: 'Central Pharmacy, Mumbai', lat: 19.076, lng: 72.8777 },
    destination: { name: 'Nanavati Hospital, Vile Parle', lat: 19.102, lng: 72.840 },
  },
];

function NewShipmentForm({
  session,
  setSession,
  onCreated,
}: {
  session: Session;
  setSession: (s: Session | null) => void;
  onCreated: () => void;
}) {
  const [preset, setPreset] = useState(0);
  const [orderCode, setOrderCode] = useState('');
  const [drugName, setDrugName] = useState('');
  const [quantity, setQuantity] = useState(100);
  const [coldChain, setColdChain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const p = PRESETS[preset];
      const res = await api(session, setSession, '/api/shipments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orderCode: orderCode.trim() || `RX-${Date.now().toString().slice(-6)}`,
          drugName: drugName.trim(),
          quantity: Number(quantity),
          coldChain,
          origin: p.origin,
          destination: p.destination,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body.error ?? 'failed to create shipment');
        return;
      }
      setOrderCode('');
      setDrugName('');
      setQuantity(100);
      setColdChain(false);
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel" onSubmit={submit}>
      <h2>Dispatch new shipment</h2>
      <div className="form-grid">
        <div className="span2">
          <label>route preset</label>
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))} style={{ width: '100%' }}>
            {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
          </select>
        </div>
        <div>
          <label>order code</label>
          <input value={orderCode} onChange={(e) => setOrderCode(e.target.value)} placeholder="auto if empty" />
        </div>
        <div>
          <label>drug</label>
          <input value={drugName} onChange={(e) => setDrugName(e.target.value)} placeholder="e.g. Insulin" required />
        </div>
        <div>
          <label>quantity</label>
          <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
        </div>
        <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={coldChain} onChange={(e) => setColdChain(e.target.checked)} /> cold chain ❄
          </label>
        </div>
        <div className="span2">
          <button className="primary" type="submit" disabled={busy || !drugName.trim()}>
            {busy ? 'Creating…' : 'Create (NOT SENT)'}
          </button>
          {error && <span className="err" style={{ marginLeft: 10, fontSize: 12 }}>{error}</span>}
        </div>
      </div>
    </form>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

function App() {
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const [shipments, setShipments] = useState<ShipmentView[]>([]);
  const [events, setEvents] = useState<LiveEventMsg[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ShipmentView['status']>('ALL');
  const [ledgerStatus, setLedgerStatus] = useState('');
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(Date.now());

  const setSession = (s: Session | null) => {
    setSessionState(s);
    saveSession(s);
  };

  const refresh = async () => {
    if (!session) return;
    try {
      const res = await api(session, setSession, '/api/shipments');
      if (res.status === 401) {
        // api() already tried rotating the refresh token and failed — the
        // session is unrecoverable (e.g. service restarted, family revoked).
        // Drop to the login screen instead of polling 401s forever.
        setSession(null);
        return;
      }
      if (res.ok) {
        const body = await res.json();
        setShipments(body.shipments);
      }
    } catch { /* service starting up */ }
  };

  // Boot validation: a hydrated session may hold a dead refresh token
  // (e.g. service restarted). Probe once; drop to login on failure.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current || !session) return;
    bootedRef.current = true;
    void (async () => {
      const res = await api(session, setSession, '/api/shipments');
      if (res.status === 401) setSession(null);
    })();
  }, [session?.accessToken]);

  useEffect(() => {
    if (!session) return;
    void refresh();
    // JWT via query param — browsers can't set WS headers. Auto-reconnect
    // every 3s on close so a service restart doesn't silently kill the
    // live feed (the 5s poll below is the data safety net).
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByUs = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/ws/live?token=${encodeURIComponent(session!.accessToken)}`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as LiveEventMsg;
          setEvents((prev) => [msg, ...prev].slice(0, 200));
          // location pings arrive ~1/s per moving shipment — update that
          // shipment's position without a full refetch
          if (msg.type === 'SHIPMENT_LOCATION') {
            const { shipmentId, lat, lng, at, progress } = msg.data as Record<string, unknown>;
            setShipments((prev) => prev.map((s) => {
              if (s.shipmentId !== shipmentId) return s;
              return {
                ...s,
                current: { lat: lat as number, lng: lng as number, at: at as string },
                progress: progress as number,
                route: [...s.route, { lat: lat as number, lng: lng as number, at: at as string }],
              };
            }));
          }
          if (msg.type === 'SHIPMENT_STATUS' || msg.type === 'SHIPMENT_CREATED') {
            void refresh(); // status changes are rare — refetch is fine
          }
        } catch { /* ignore malformed */ }
      };
    };
    connect();
    const iv = setInterval(refresh, 5000); // safety net if WS drops
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(iv);
      clearInterval(clock);
      ws?.close();
    };
  }, [session?.accessToken]);

  const logout = async () => {
    if (session) {
      await api(session, setSession, '/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    }
    setSession(null);
    setShipments([]);
    setEvents([]);
  };

  const canDispatch = session?.role === 'admin' || session?.role === 'operator';
  const canAudit = session?.role === 'admin' || session?.role === 'auditor';

  const filtered = useMemo(
    () => (statusFilter === 'ALL' ? shipments : shipments.filter((s) => s.status === statusFilter)),
    [shipments, statusFilter],
  );
  const counts = useMemo(() => ({
    notSent: shipments.filter((s) => s.status === 'NOT_SENT').length,
    inTransit: shipments.filter((s) => s.status === 'IN_TRANSIT').length,
    delivered: shipments.filter((s) => s.status === 'DELIVERED').length,
  }), [shipments]);
  const selected = shipments.find((s) => s.shipmentId === selectedId) ?? null;

  const advance = async (s: ShipmentView, to: ShipmentView['status']) => {
    if (!session) return;
    const res = await api(session, setSession, `/api/shipments/${s.shipmentId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (res.ok) void refresh();
  };

  const verifyLedger = async () => {
    if (!session) return;
    const res = await api(session, setSession, '/api/audit/verify').then((r) => r.json());
    setLedgerStatus(res.valid ? `✅ chain valid (${res.blocksChecked} blocks)` : `❌ TAMPERED at block ${res.firstBadIndex}: ${res.reason}`);
  };

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Medicine Logistics — Live Tracking</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThemeToggle />
          <span className={connected ? 'ok' : 'warn'}>{connected ? '● live' : '○ reconnecting'}</span>
          <span>{session.username} ({session.role}) ·</span>
          <button onClick={logout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">
        Real-time location of every drug shipment — not sent, on the way, or delivered. Positions stream over WebSocket.
      </div>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Not sent</h2>
          <div className="metric" style={{ color: 'var(--amber)' }}>{counts.notSent} <small>waiting at the depot</small></div>
        </div>
        <div className="panel">
          <h2>On the way</h2>
          <div className="metric" style={{ color: 'var(--accent)' }}>{counts.inTransit} <small>moving now — live GPS</small></div>
        </div>
        <div className="panel">
          <h2>Delivered</h2>
          <div className="metric" style={{ color: 'var(--green)' }}>{counts.delivered} <small>arrived &amp; signed</small></div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Live map</h2>
          <LiveMap shipments={filtered} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div>
          {selected ? (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h2>{selected.orderCode} — {selected.drugName}</h2>
              <div className="detail-grid">
                <div className="row"><span className="k">status</span><span><span className={`badge ${STATUS_CLASS[selected.status]}`}>{STATUS_LABEL[selected.status]}</span>{selected.coldChain && <span className="badge cold">❄ COLD CHAIN</span>}</span></div>
                <div className="row"><span className="k">quantity</span><span>{selected.quantity}</span></div>
                <div className="row"><span className="k">from</span><span>{selected.origin.name}</span></div>
                <div className="row"><span className="k">to</span><span>{selected.destination.name}</span></div>
                <div className="row"><span className="k">distance</span><span>{selected.distanceKm} km</span></div>
                <div className="row"><span className="k">remaining</span><span>{selected.remainingKm != null ? `${selected.remainingKm} km` : '—'}</span></div>
                <div className="row"><span className="k">ETA</span><span>{selected.etaMinutes != null ? `${selected.etaMinutes} min` : '—'}</span></div>
                <div className="row"><span className="k">last update</span><span>{selected.current ? fmtTime(selected.current.at) : '—'}</span></div>
                <div className="row"><span className="k">created</span><span>{fmtTime(selected.createdAt)} by {selected.createdBy?.username ?? 'system'}</span></div>
                <div className="row"><span className="k">delivered</span><span>{selected.deliveredAt ? fmtTime(selected.deliveredAt) : '—'}</span></div>
              </div>
              <div className="progress-bar">
                <div
                  className={selected.status === 'DELIVERED' ? 'done' : selected.status === 'NOT_SENT' ? 'waiting' : ''}
                  style={{ width: `${selected.progress}%` }}
                />
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="k">{selected.progress}% of route</span>
                <span className="k">{selected.route.length} GPS pings</span>
              </div>
              {canDispatch && selected.status !== 'DELIVERED' && (
                <div className="controls" style={{ marginTop: 8 }}>
                  {selected.status === 'NOT_SENT' && (
                    <button className="primary" onClick={() => advance(selected, 'IN_TRANSIT')}>Dispatch → on the way</button>
                  )}
                  {selected.status === 'IN_TRANSIT' && (
                    <button className="primary" onClick={() => advance(selected, 'DELIVERED')}>Mark delivered</button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h2>Shipment detail</h2>
              <div className="muted" style={{ fontSize: 13 }}>Select a shipment on the map or in the table.</div>
            </div>
          )}
          <div className="panel">
            <h2>Live event log</h2>
            <div className="event-log">
              {events.length === 0 && <div className="muted">waiting for events…</div>}
              {events.map((e, i) => (
                <div key={i}>
                  <span className="warn">[{fmtTime(e.ts)}]</span>{' '}
                  <span className="ok">{e.type}</span>{' '}
                  {e.data.orderCode ? <b>{String(e.data.orderCode)}</b> : null}{' '}
                  {e.type === 'SHIPMENT_LOCATION'
                    ? <span className="muted">{String(e.data.drugName)} @ {Number(e.data.lat).toFixed(3)}, {Number(e.data.lng).toFixed(3)} ({String(e.data.progress)}%)</span>
                    : <span className="muted">{JSON.stringify(e.data)}</span>}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {canDispatch && (
        <NewShipmentForm session={session} setSession={setSession} onCreated={() => void refresh()} />
      )}

      <div className="panel" style={{ marginTop: 16 }}>
        <h2>All shipments</h2>
        <div className="controls">
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="ALL">all statuses</option>
            <option value="NOT_SENT">not sent</option>
            <option value="IN_TRANSIT">on the way</option>
            <option value="DELIVERED">delivered</option>
          </select>
          {canAudit && (
            <>
              <button onClick={verifyLedger}>Run ledger integrity check</button>
              <span style={{ fontSize: 12 }}>{ledgerStatus}</span>
            </>
          )}
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>
            {filtered.length} shown · updated {fmtTime(new Date(now).toISOString())}
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th>order</th>
              <th>drug</th>
              <th>qty</th>
              <th>status</th>
              <th>from</th>
              <th>to</th>
              <th>progress</th>
              <th>ETA</th>
              <th>last ping</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr
                key={s.shipmentId}
                className={`shipment-row ${s.shipmentId === selectedId ? 'selected' : ''}`}
                onClick={() => setSelectedId(s.shipmentId)}
              >
                <td><b>{s.orderCode}</b></td>
                <td>{s.drugName}{s.coldChain && <span className="badge cold">❄</span>}</td>
                <td>{s.quantity}</td>
                <td><span className={`badge ${STATUS_CLASS[s.status]}`}>{STATUS_LABEL[s.status]}</span></td>
                <td>{s.origin.name.split(',')[0]}</td>
                <td>{s.destination.name.split(',')[0]}</td>
                <td style={{ minWidth: 120 }}>
                  {s.progress}%
                  <div className="progress-bar">
                    <div className={s.status === 'DELIVERED' ? 'done' : s.status === 'NOT_SENT' ? 'waiting' : ''} style={{ width: `${s.progress}%` }} />
                  </div>
                </td>
                <td>{s.etaMinutes != null ? `${s.etaMinutes}m` : '—'}</td>
                <td className="muted">{s.current ? fmtTime(s.current.at) : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>no shipments match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="footer-note">
        Independent logistics service (:4301) — tracks medicine deliveries end-to-end (not sent → on the way → delivered) with live GPS streaming,
        hash-chained audit ledger, JWT auth + RBAC, and the same middleware pipeline as the clinical network. It shares no runtime state with the
        reference-data services and keeps working even if they are down.
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
