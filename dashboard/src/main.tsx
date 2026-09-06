import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface SiteState {
  siteId: string;
  watermark: number;
  baseLatencyMs: number;
  jitterMs: number;
  dropRate: number;
}

interface AlertResultView {
  orderId: string;
  siteId: string;
  epochUsed: number;
  watermarkAtEval: number;
  fires: boolean;
  severity: string;
  ruleId: string | null;
  provisional: boolean;
  evaluatedAt: string;
}

interface LiveEventMsg {
  type: string;
  data: Record<string, unknown>;
  ts: string;
}

interface Session {
  accessToken: string;
  refreshToken: string;
  role: string;
  username: string;
}

interface HospitalView {
  siteId: string;
  name: string;
  region: string;
  simulated: boolean;
  createdAt: string;
  baseLatencyMs: number;
  jitterMs: number;
  dropRate: number;
  doctorCount: number;
}

interface DoctorView {
  userId: string;
  username: string;
  hospitalId?: string;
  fullName?: string;
  hospitalName?: string | null;
}

interface DrugView {
  id: string;
  drugName: string;
  hospitalId: string;
  addedBy: { userId: string; username: string; role: string } | null;
  addedAt: string;
}

interface HospitalDetailView extends HospitalView {
  network: { baseLatencyMs: number; jitterMs: number; dropRate: number } | null;
  drugs: DrugView[];
  doctors: Array<{ userId: string; username: string; hospitalId?: string; fullName?: string }>;
}

interface PublisherView {
  userId: string;
  username: string;
  role: string;
  hospitalId?: string | null;
}

interface PatientDataView {
  patientRef: string;
  firstName: string;
  lastName: string;
  dob: string;
  gender: string;
  disease: string;
  drugs: string[];
  interactions?: string[];
}

interface PatientViewT {
  patientId: string;
  email: string;
  data: PatientDataView;
  createdAt: string;
  createdBy: { userId: string; username: string; role: string } | null;
  status: 'active' | 'deactivated';
  hospitalNames?: Array<{ siteId: string; name: string }>;
  visitCount?: number;
  history?: PatientChangeBlockView[];
  visits?: PatientVisitView[];
}

interface PatientChangeBlockView {
  seq: number;
  patientId: string;
  changedBy: { userId: string; username: string; role: string } | null;
  changedAt: string;
  reason: string;
  changes: Record<string, { before: unknown; after: unknown }>;
}

interface PatientVisitView {
  visitId: string;
  patientId: string;
  hospitalId: string;
  hospitalName?: string;
  visitedAt: string;
  reason: string;
  recordedBy: { userId: string; username: string; role: string } | null;
}

/** Age in years from an ISO dob, as of today. */
function calcAge(dob: string): number {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return 0;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// ── Logistics (independent tracking service, mounted as its own page) ─────────
// The logistics service has its OWN auth domain (its own users + JWTs), so the
// page keeps a separate session under 'hc-logistics-session' and talks to the
// service through the /logistics-api proxy prefix.

interface LogSession {
  accessToken: string;
  refreshToken: string;
  role: string;
  username: string;
}

interface GeoPoint {
  lat: number;
  lng: number;
  at: string;
}

interface LogPlace {
  name: string;
  lat: number;
  lng: number;
}

type ShipmentStatus = 'NOT_SENT' | 'IN_TRANSIT' | 'DELIVERED';

interface ShipmentViewT {
  shipmentId: string;
  orderCode: string;
  drugName: string;
  quantity: number;
  coldChain: boolean;
  status: ShipmentStatus;
  origin: LogPlace;
  destination: LogPlace;
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

interface LogisticsEventMsg {
  type: 'SHIPMENT_CREATED' | 'SHIPMENT_STATUS' | 'SHIPMENT_LOCATION' | 'LEDGER';
  data: Record<string, unknown>;
  ts: string;
}

const LOG_SESSION_KEY = 'hc-logistics-session';
let inflightLogRefresh: Promise<LogSession | null> | null = null;

function saveLogSession(s: LogSession | null): void {
  try {
    if (s) localStorage.setItem(LOG_SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(LOG_SESSION_KEY);
  } catch { /* private mode */ }
}

function loadLogSession(): LogSession | null {
  try {
    const raw = localStorage.getItem(LOG_SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as LogSession;
    if (!s?.accessToken || !s?.refreshToken || !s.role) return null;
    return s;
  } catch {
    return null;
  }
}

async function refreshLogSession(session: LogSession): Promise<LogSession | null> {
  if (!inflightLogRefresh) {
    inflightLogRefresh = (async () => {
      try {
        const r = await fetch('/logistics-api/auth/refresh', {
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
        } satisfies LogSession;
      } catch {
        return null;
      } finally {
        setTimeout(() => { inflightLogRefresh = null; }, 0);
      }
    })();
  }
  return inflightLogRefresh;
}

async function logApi(session: LogSession, setSession: (s: LogSession | null) => void, url: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  let res = await doFetch(session.accessToken);
  if (res.status === 401) {
    const next = await refreshLogSession(session);
    if (next) {
      setSession(next);
      res = await doFetch(next.accessToken);
    }
  }
  return res;
}

const LOG_STATUS_COLOR: Record<ShipmentStatus, string> = {
  NOT_SENT: '#d29922',
  IN_TRANSIT: '#58a6ff',
  DELIVERED: '#3fb950',
};

const LOG_STATUS_CLASS: Record<ShipmentStatus, string> = {
  NOT_SENT: 'low',
  IN_TRANSIT: 'none',
  DELIVERED: 'none',
};

const LOG_STATUS_LABEL: Record<ShipmentStatus, string> = {
  NOT_SENT: 'NOT SENT',
  IN_TRANSIT: 'ON THE WAY',
  DELIVERED: 'DELIVERED',
};

const SEVERITY_CLASS: Record<string, string> = {
  NONE: 'none',
  LOW: 'low',
  MODERATE: 'moderate',
  SEVERE: 'severe',
  CRITICAL: 'critical',
};

/**
 * Format an ISO/UTC timestamp as IST (Indian Standard Time, UTC+5:30) with
 * the date — e.g. "06 Sep 2026, 02:48:17 PM IST". Fixed to Asia/Kolkata so
 * every dashboard shows Indian time regardless of the viewer's locale.
 */
function fmtIST(iso: string, withSeconds = true): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hour12: true,
  });
  return `${date}, ${time} IST`;
}

/**
 * Authenticated fetch with automatic refresh-token rotation on 401.
 * Single-flight: concurrent 401s share ONE in-flight refresh call — otherwise
 * parallel requests race, each rotates the refresh token, and the reuse of an
 * already-rotated token trips theft detection (family revocation).
 */
let inflightRefresh: Promise<Session | null> | null = null;

// ── Session persistence: survive page refreshes for months ─────────────────
// The session (tokens + role) is stored in localStorage. On boot we hydrate
// it; if the access token has expired the shared refresh rotation mints a
// fresh one (server-side refresh tokens now live for months), so users stay
// logged in across refreshes, tabs, and browser restarts.

const SESSION_KEY = 'hc-session';

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
        // allow a future refresh once this one settles
        setTimeout(() => { inflightRefresh = null; }, 0);
      }
    })();
  }
  return inflightRefresh;
}

async function api(session: Session, setSession: (s: Session | null) => void, url: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string) =>
    fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
  let res = await doFetch(session.accessToken);
  if (res.status === 401) {
    // access token expired — rotate the refresh token once (shared across concurrent callers)
    const next = await refreshSession(session);
    if (next) {
      setSession(next);
      res = await doFetch(next.accessToken);
    }
  }
  return res;
}

type Theme = 'dark' | 'light';

/** Read the boot-script-initialized theme attr as reactive state. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const t = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-theme') : null;
    return t === 'light' ? 'light' : 'dark';
  });
  const toggle = () => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('hc-theme', next); } catch { /* ignore */ }
      return next;
    });
  };
  return [theme, toggle];
}

/** Theme switch shown in the header of every page. */
function ThemeToggle() {
  const [theme, toggle] = useTheme();
  return (
    <button
      className="theme-toggle"
      onClick={toggle}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle dark or light theme"
    >
      {theme === 'dark' ? '☾ dark' : '☀ light'}
    </button>
  );
}

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
      <h1>Clinical Reference-Data Consistency</h1>
      <div className="subtitle">Sign in to view the live multi-site consistency dashboard</div>
      <form className="panel" onSubmit={submit}>
        <h2>Sign in</h2>
        <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <input placeholder="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          <input placeholder="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          <button className="primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          {error && <div className="err" style={{ fontSize: 13 }}>{error}</div>}
        </div>
        <div className="footer-note" style={{ marginTop: 12 }}>
          Demo accounts — admin/admin123 · operator/operator123 · auditor/auditor123 · viewer/viewer123 · doctor/doctor123 · patient: ava.thompson@demo.health / patient12345 · nurse: nurse@demo.health / nurse12345
        </div>
      </form>
    </div>
  );
}

interface RuleVersionView {
  ruleId: string;
  version: number;
  globalSeq: number;
  payload: { drugA?: string; drugB?: string; severity?: string; note?: string };
  createdAt: string;
  publishedBy?: PublisherView;
}

interface NurseLookupView {
  maskedName: string;
  age: number;
  gender: string;
  disease: string;
  drugs: string[];
  interactions?: string[];
  lastVisit: { at: string; reason: string; hospitalName: string } | null;
}

/**
 * Nurse dashboard — takes a patient's portal email and shows ONLY a masked,
 * minimal clinical summary: masked name (r**k), age, gender, condition,
 * drugs, and the last visit (date/time + reason). Nothing else is exposed —
 * no IDs, no DOB, no history, no contact details.
 */
function NursePage({ session, setSession, onLogout }: { session: Session; setSession: (s: Session | null) => void; onLogout: () => void }) {
  const [email, setEmail] = useState('');
  const [result, setResult] = useState<NurseLookupView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const lookup = async () => {
    const mail = email.trim();
    if (!mail.includes('@')) { setError('enter the patient portal email'); return; }
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const res = await api(session, setSession, '/api/patients/lookup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: mail }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'lookup failed'); return; }
      setResult(body);
    } finally { setBusy(false); }
  };

  return (
    <div className="app" style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Nurse Dashboard — Patient Lookup</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThemeToggle />
          <span>{session.username} ·</span>
          <button onClick={onLogout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">
        Enter the patient's portal email to view their masked clinical summary. Names are partially hidden for privacy — e.g. "Rock" is shown as "R**k".
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
          <input
            placeholder="patient portal email (e.g. ava.thompson@demo.health)"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void lookup(); }}
          />
          <button className="primary" onClick={lookup} disabled={busy}>{busy ? 'Looking up…' : 'Look up patient'}</button>
          {error && <div className="err" style={{ fontSize: 13 }}>{error}</div>}
        </div>
      </div>

      {result && (
        <div className="panel">
          <h2>Patient summary</h2>
          <div className="row"><span className="k">name (masked)</span><span>{result.maskedName}</span></div>
          <div className="row"><span className="k">age</span><span>{result.age} years</span></div>
          <div className="row"><span className="k">gender</span><span>{result.gender}</span></div>
          <div className="row"><span className="k">disease / condition</span><span>{result.disease}</span></div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span className="k">drugs / medicine</span>
            <span style={{ textAlign: 'right' }}>
              {result.drugs.length > 0
                ? result.drugs.map((d) => <span key={d} className="badge low" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{d}</span>)
                : <span className="muted">none</span>}
            </span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span className="k">active interactions</span>
            <span style={{ textAlign: 'right' }}>
              {(result.interactions ?? []).length > 0
                ? result.interactions!.map((i) => <div key={i} className="badge severe" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{i}</div>)
                : <span className="ok">none known</span>}
            </span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <span className="k">last visit</span>
            <span style={{ textAlign: 'right' }}>
              {result.lastVisit
                ? <>{fmtIST(result.lastVisit.at, false)}<br /><span className="muted" style={{ fontSize: 12 }}>{result.lastVisit.hospitalName} — {result.lastVisit.reason}</span></>
                : <span className="muted">no visits recorded</span>}
            </span>
          </div>
        </div>
      )}

      <div className="footer-note">
        Nurses see a privacy-filtered view only. Patient records can be changed exclusively by doctors and administrators.
      </div>
    </div>
  );
}
// ── Logistics page (independent tracking service) ─────────────────────────────

/** SVG map of shipments — no external tile dependency. */
function LogisticsMap({ shipments, selectedId, onSelect }: {
  shipments: ShipmentViewT[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const W = 800;
  const H = 460;
  const PAD = 40;

  const bounds = React.useMemo(() => {
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
    const dLat = Math.max(0.02, (maxLat - minLat) * 0.15);
    const dLng = Math.max(0.02, (maxLng - minLng) * 0.15);
    return { minLat: minLat - dLat, maxLat: maxLat + dLat, minLng: minLng - dLng, maxLng: maxLng + dLng };
  }, [shipments]);

  const project = (lat: number, lng: number) => ({
    x: PAD + ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * (W - 2 * PAD),
    y: H - PAD - ((lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * (H - 2 * PAD),
  });

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img" aria-label="Live shipment map">
        {Array.from({ length: 9 }, (_, i) => (
          <line key={`h${i}`} x1={0} x2={W} y1={(i + 1) * (H / 10)} y2={(i + 1) * (H / 10)} stroke="var(--border)" strokeWidth="1" strokeOpacity={0.4} />
        ))}
        {Array.from({ length: 15 }, (_, i) => (
          <line key={`v${i}`} y1={0} y2={H} x1={(i + 1) * (W / 16)} x2={(i + 1) * (W / 16)} stroke="var(--border)" strokeWidth="1" strokeOpacity={0.4} />
        ))}
        {shipments.map((s) => {
          const o = project(s.origin.lat, s.origin.lng);
          const d = project(s.destination.lat, s.destination.lng);
          const path = s.route.map((p) => project(p.lat, p.lng));
          const cur = s.current ? project(s.current.lat, s.current.lng) : o;
          const selected = s.shipmentId === selectedId;
          return (
            <g key={s.shipmentId} onClick={() => onSelect(s.shipmentId)} style={{ cursor: 'pointer' }}>
              {path.length > 1 && (
                <polyline
                  points={path.map((p) => `${p.x},${p.y}`).join(' ')}
                  fill="none"
                  stroke={LOG_STATUS_COLOR[s.status]}
                  strokeOpacity={selected ? 0.9 : 0.45}
                  strokeWidth={selected ? 2.5 : 1.5}
                  strokeDasharray={s.status === 'DELIVERED' ? undefined : '4 3'}
                />
              )}
              <rect x={o.x - 4} y={o.y - 4} width={8} height={8} fill="var(--muted)" rx={1} />
              <circle cx={d.x} cy={d.y} r={5} fill="none" stroke={LOG_STATUS_COLOR[s.status]} strokeWidth={2} />
              {s.status === 'DELIVERED' && <circle cx={d.x} cy={d.y} r={2} fill={LOG_STATUS_COLOR.DELIVERED} />}
              {s.status !== 'DELIVERED' && (
                <>
                  <circle cx={cur.x} cy={cur.y} r={selected ? 9 : 7} fill={LOG_STATUS_COLOR[s.status]} fillOpacity={0.25} />
                  <circle cx={cur.x} cy={cur.y} r={4} fill={LOG_STATUS_COLOR[s.status]} />
                  {s.coldChain && <text x={cur.x + 8} y={cur.y - 6} fontSize={11} fill="var(--accent)">❄</text>}
                </>
              )}
              <text x={o.x + 7} y={o.y - 6} fontSize={10} fill="var(--muted)">{s.origin.name.split(',')[0]}</text>
              <text x={d.x + 7} y={d.y + 12} fontSize={10} fill="var(--muted)">{s.destination.name.split(',')[0]}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--muted)', marginTop: 6, flexWrap: 'wrap' }}>
        <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: LOG_STATUS_COLOR.NOT_SENT, marginRight: 4 }} />not sent</span>
        <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: LOG_STATUS_COLOR.IN_TRANSIT, marginRight: 4 }} />on the way</span>
        <span><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: LOG_STATUS_COLOR.DELIVERED, marginRight: 4 }} />delivered</span>
        <span>❄ cold chain</span>
      </div>
    </div>
  );
}

const LOG_PRESETS: Array<{ label: string; origin: LogPlace; destination: LogPlace }> = [
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

/**
 * Logistics page — real-time medicine shipment tracking, its own sub-app
 * inside the main dashboard with a SEPARATE auth domain (the logistics
 * service has its own users). Reached via the redirect buttons on the
 * admin/doctor dashboards; not the main page.
 */
function LogisticsPage({ onBack, themeToggle }: { onBack: () => void; themeToggle: React.ReactNode }) {
  const [session, setSessionState] = useState<LogSession | null>(() => loadLogSession());
  const [shipments, setShipments] = useState<ShipmentViewT[]>([]);
  const [events, setEvents] = useState<LogisticsEventMsg[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'ALL' | ShipmentStatus>('ALL');
  const [ledgerStatus, setLedgerStatus] = useState('');
  const [connected, setConnected] = useState(false);
  // login form
  const [lu, setLu] = useState('admin');
  const [lp, setLp] = useState('admin123');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  // new shipment form
  const [preset, setPreset] = useState(0);
  const [orderCode, setOrderCode] = useState('');
  const [drugName, setDrugName] = useState('');
  const [quantity, setQuantity] = useState(100);
  const [coldChain, setColdChain] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState('');

  const setSession = (s: LogSession | null) => {
    setSessionState(s);
    saveLogSession(s);
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginBusy(true);
    setLoginError('');
    try {
      const r = await fetch('/logistics-api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: lu.trim(), password: lp }),
      });
      const body = await r.json();
      if (!r.ok) { setLoginError(body.error ?? 'login failed'); return; }
      setSession(body);
    } finally { setLoginBusy(false); }
  };

  const refresh = async () => {
    if (!session) return;
    try {
      const res = await logApi(session, setSession, '/logistics-api/shipments');
      if (res.status === 401) { setSession(null); return; }
      if (res.ok) {
        const body = await res.json();
        setShipments(body.shipments);
      }
    } catch { /* service starting up */ }
  };

  React.useEffect(() => {
    if (!session) return;
    void refresh();
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closedByUs = false;
    const connect = () => {
      ws = new WebSocket(`ws://${location.host}/logistics-ws/live?token=${encodeURIComponent(session!.accessToken)}`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closedByUs) reconnectTimer = setTimeout(connect, 3000);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as LogisticsEventMsg;
          setEvents((prev) => [msg, ...prev].slice(0, 200));
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
            void refresh();
          }
        } catch { /* ignore malformed */ }
      };
    };
    connect();
    const iv = setInterval(refresh, 5000);
    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearInterval(iv);
      ws?.close();
    };
  }, [session?.accessToken]);

  const logout = async () => {
    if (session) {
      await logApi(session, setSession, '/logistics-api/auth/logout', { method: 'POST' }).catch(() => undefined);
    }
    setSession(null);
    setShipments([]);
    setEvents([]);
  };

  const createShipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!session) return;
    setCreateBusy(true);
    setCreateError('');
    try {
      const p = LOG_PRESETS[preset];
      const res = await logApi(session, setSession, '/logistics-api/shipments', {
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
      if (!res.ok) { setCreateError(body.error ?? 'failed to create shipment'); return; }
      setOrderCode(''); setDrugName(''); setQuantity(100); setColdChain(false);
      void refresh();
    } finally { setCreateBusy(false); }
  };

  const advance = async (s: ShipmentViewT, to: ShipmentStatus) => {
    if (!session) return;
    const res = await logApi(session, setSession, `/logistics-api/shipments/${s.shipmentId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    if (res.ok) void refresh();
  };

  const verifyLedger = async () => {
    if (!session) return;
    const res = await logApi(session, setSession, '/logistics-api/audit/verify').then((r) => r.json());
    setLedgerStatus(res.valid ? `✅ chain valid (${res.blocksChecked} blocks)` : `❌ TAMPERED at block ${res.firstBadIndex}: ${res.reason}`);
  };

  if (!session) {
    return (
      <div className="app" style={{ maxWidth: 460 }}>
        <div className="back-link"><button onClick={onBack}>← back to dashboard</button></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{themeToggle}</div>
        <h1>Medicine Logistics — Sign in</h1>
        <div className="subtitle">The logistics service has its own accounts (independent of the clinical system).</div>
        <form className="panel" onSubmit={login}>
          <h2>Logistics sign in</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="username" value={lu} onChange={(e) => setLu(e.target.value)} autoComplete="username" />
            <input placeholder="password" type="password" value={lp} onChange={(e) => setLp(e.target.value)} autoComplete="current-password" />
            <button className="primary" type="submit" disabled={loginBusy}>{loginBusy ? 'Signing in…' : 'Sign in'}</button>
            {loginError && <div className="err" style={{ fontSize: 13 }}>{loginError}</div>}
          </div>
          <div className="footer-note" style={{ marginTop: 12 }}>
            Demo accounts — admin/admin123 · dispatcher/dispatcher123 · driver/driver123 · auditor/auditor123 · viewer/viewer123
          </div>
        </form>
      </div>
    );
  }

  const canDispatch = session.role === 'admin' || session.role === 'operator';
  const canAudit = session.role === 'admin' || session.role === 'auditor';
  const filtered = statusFilter === 'ALL' ? shipments : shipments.filter((s) => s.status === statusFilter);
  const counts = {
    notSent: shipments.filter((s) => s.status === 'NOT_SENT').length,
    inTransit: shipments.filter((s) => s.status === 'IN_TRANSIT').length,
    delivered: shipments.filter((s) => s.status === 'DELIVERED').length,
  };
  const selected = shipments.find((s) => s.shipmentId === selectedId) ?? null;

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="back-link" style={{ marginBottom: 0 }}><button onClick={onBack}>← back to dashboard</button></div>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          {themeToggle}
          <span className={connected ? 'ok' : 'warn'}>{connected ? '● live' : '○ reconnecting'}</span>
          <span>{session.username} ({session.role}) ·</span>
          <button onClick={logout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <h1 style={{ marginTop: 8 }}>Medicine Logistics — Live Tracking</h1>
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
          <LogisticsMap shipments={filtered} selectedId={selectedId} onSelect={setSelectedId} />
        </div>
        <div>
          {selected ? (
            <div className="panel" style={{ marginBottom: 16 }}>
              <h2>{selected.orderCode} — {selected.drugName}</h2>
              <div className="row"><span className="k">status</span><span><span className={`badge ${LOG_STATUS_CLASS[selected.status]}`}>{LOG_STATUS_LABEL[selected.status]}</span>{selected.coldChain && <span className="badge low" style={{ marginLeft: 6 }}>❄ COLD CHAIN</span>}</span></div>
              <div className="row"><span className="k">quantity</span><span>{selected.quantity}</span></div>
              <div className="row"><span className="k">from</span><span>{selected.origin.name}</span></div>
              <div className="row"><span className="k">to</span><span>{selected.destination.name}</span></div>
              <div className="row"><span className="k">distance</span><span>{selected.distanceKm} km</span></div>
              <div className="row"><span className="k">remaining</span><span>{selected.remainingKm != null ? `${selected.remainingKm} km` : '—'}</span></div>
              <div className="row"><span className="k">ETA</span><span>{selected.etaMinutes != null ? `${selected.etaMinutes} min` : '—'}</span></div>
              <div className="row"><span className="k">last update</span><span>{selected.current ? fmtIST(selected.current.at, false) : '—'}</span></div>
              <div className="row"><span className="k">created</span><span>{fmtIST(selected.createdAt)} by {selected.createdBy?.username ?? 'system'}</span></div>
              <div className="row"><span className="k">delivered</span><span>{selected.deliveredAt ? fmtIST(selected.deliveredAt, false) : '—'}</span></div>
              <div style={{ height: 8, background: 'var(--border)', borderRadius: 4, marginTop: 10, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${selected.progress}%`, background: selected.status === 'DELIVERED' ? 'var(--green)' : selected.status === 'NOT_SENT' ? 'var(--amber)' : 'var(--accent)' }} />
              </div>
              <div className="row" style={{ marginTop: 4 }}>
                <span className="k">{selected.progress}% of route</span>
                <span className="k">{selected.route.length} GPS pings</span>
              </div>
              {canDispatch && selected.status !== 'DELIVERED' && (
                <div className="controls" style={{ marginTop: 8 }}>
                  {selected.status === 'NOT_SENT' && (
                    <button className="primary" onClick={() => void advance(selected, 'IN_TRANSIT')}>Dispatch → on the way</button>
                  )}
                  {selected.status === 'IN_TRANSIT' && (
                    <button className="primary" onClick={() => void advance(selected, 'DELIVERED')}>Mark delivered</button>
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
                  <span className="warn">[{fmtIST(e.ts)}]</span>{' '}
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
        <form className="panel" onSubmit={createShipment} style={{ marginBottom: 16 }}>
          <h2>Dispatch new shipment</h2>
          <div className="grid cols-3">
            <div>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>route preset</label>
              <select value={preset} onChange={(e) => setPreset(Number(e.target.value))} style={{ width: '100%' }}>
                {LOG_PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
              </select>
              <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginTop: 8 }}>order code</label>
              <input value={orderCode} onChange={(e) => setOrderCode(e.target.value)} placeholder="auto if empty" style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ fontSize: 12, color: 'var(--muted)' }}>drug</label>
              <input value={drugName} onChange={(e) => setDrugName(e.target.value)} placeholder="e.g. Insulin" required style={{ width: '100%' }} />
              <label style={{ fontSize: 12, color: 'var(--muted)', display: 'block', marginTop: 8 }}>quantity</label>
              <input type="number" min={1} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginTop: 18 }}>
                <input type="checkbox" checked={coldChain} onChange={(e) => setColdChain(e.target.checked)} /> cold chain ❄
              </label>
              <button className="primary" type="submit" disabled={createBusy || !drugName.trim()} style={{ marginTop: 12 }}>
                {createBusy ? 'Creating…' : 'Create (NOT SENT)'}
              </button>
              {createError && <div className="err" style={{ fontSize: 12, marginTop: 6 }}>{createError}</div>}
            </div>
          </div>
        </form>
      )}

      <div className="panel" style={{ marginTop: 0 }}>
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
              <button onClick={() => void verifyLedger()}>Run ledger integrity check</button>
              <span style={{ fontSize: 12 }}>{ledgerStatus}</span>
            </>
          )}
          <span className="muted" style={{ fontSize: 12, marginLeft: 'auto' }}>{filtered.length} shown</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>order</th><th>drug</th><th>qty</th><th>status</th><th>from</th><th>to</th><th>progress</th><th>ETA</th><th>last ping</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr
                key={s.shipmentId}
                style={{ cursor: 'pointer', background: s.shipmentId === selectedId ? 'var(--btn-bg)' : undefined }}
                onClick={() => setSelectedId(s.shipmentId)}
              >
                <td><b>{s.orderCode}</b></td>
                <td>{s.drugName}{s.coldChain && <span className="badge low" style={{ marginLeft: 4 }}>❄</span>}</td>
                <td>{s.quantity}</td>
                <td><span className={`badge ${LOG_STATUS_CLASS[s.status]}`}>{LOG_STATUS_LABEL[s.status]}</span></td>
                <td>{s.origin.name.split(',')[0]}</td>
                <td>{s.destination.name.split(',')[0]}</td>
                <td style={{ minWidth: 120 }}>
                  {s.progress}%
                  <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, marginTop: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${s.progress}%`, background: s.status === 'DELIVERED' ? 'var(--green)' : s.status === 'NOT_SENT' ? 'var(--amber)' : 'var(--accent)' }} />
                  </div>
                </td>
                <td>{s.etaMinutes != null ? `${s.etaMinutes}m` : '—'}</td>
                <td className="muted">{s.current ? fmtIST(s.current.at, false) : '—'}</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={9} className="muted" style={{ textAlign: 'center', padding: 16 }}>no shipments match this filter</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="footer-note">
        Independent logistics service (:4301) — live GPS streaming with a hash-chained audit ledger and its own RBAC.
        Reached from the admin/doctor dashboard; it keeps working even if the clinical services are down.
      </div>
    </div>
  );
}

/**
 * Patient portal — strictly read-only personal health view. The patient logs
 * in with the email/password their doctor/admin provided and sees their
 * demographics (with calculated age), disease, drugs, hospital visits, and
 * the full change history of their record. No edit controls exist here by
 * design — only a doctor or admin can change patient data.
 */
function PatientPortal({ session, setSession, onLogout }: { session: Session; setSession: (s: Session | null) => void; onLogout: () => void }) {
  const [me, setMe] = useState<PatientViewT | null>(null);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const res = await api(session, setSession, '/api/patients/me');
      const body = await res.json();
      if (res.ok) setMe(body);
      else setError(body.error ?? 'could not load your record');
    } catch {
      setError('services starting up — try again shortly');
    }
  };

  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 10000);
    return () => clearInterval(iv);
  }, [session?.accessToken]);

  const d = me?.data;

  return (
    <div className="app" style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>My Health Record</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <ThemeToggle />
          <span>{session.username} ·</span>
          <button onClick={onLogout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">Your information is read-only. Only your doctor or an administrator can change it — every change is permanently recorded.</div>

      {error && <div className="panel"><div className="err">{error}</div></div>}
      {!me && !error && <div className="panel"><h2>Loading your record…</h2></div>}

      {me && d && (
        <>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <div className="panel">
              <h2>Personal information</h2>
              <div className="row"><span className="k">patient ID</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{d.patientRef}</span></div>
              <div className="row"><span className="k">first name</span><span>{d.firstName}</span></div>
              <div className="row"><span className="k">last name</span><span>{d.lastName}</span></div>
              <div className="row"><span className="k">date of birth</span><span>{d.dob} (age {calcAge(d.dob)})</span></div>
              <div className="row"><span className="k">gender</span><span>{d.gender}</span></div>
              <div className="row"><span className="k">record created</span><span className="muted">{fmtIST(me.createdAt)}</span></div>
            </div>
            <div className="panel">
              <h2>Condition & medication</h2>
              <div className="row"><span className="k">disease</span><span>{d.disease}</span></div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="k">drugs / medicine</span>
                <span style={{ textAlign: 'right' }}>
                  {d.drugs.length > 0
                    ? d.drugs.map((drug) => <span key={drug} className="badge low" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{drug}</span>)
                    : <span className="muted">none</span>}
                </span>
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <span className="k">active interactions</span>
                <span style={{ textAlign: 'right' }}>
                  {(d.interactions ?? []).length > 0
                    ? d.interactions!.map((i) => <div key={i} className="badge severe" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{i}</div>)
                    : <span className="ok">none known</span>}
                </span>
              </div>
              <div className="row"><span className="k">status</span><span>{me.status === 'active' ? <span className="ok">active</span> : <span className="err">deactivated</span>}</span></div>
            </div>
          </div>

          <div className="panel" style={{ marginBottom: 16 }}>
            <h2>Hospitals I visited</h2>
            <table>
              <thead><tr><th>hospital</th><th>when</th><th>reason</th><th>recorded by</th></tr></thead>
              <tbody>
                {(me.visits ?? []).map((v) => (
                  <tr key={v.visitId}>
                    <td>{v.hospitalName ?? v.hospitalId}</td>
                    <td className="muted">{fmtIST(v.visitedAt)}</td>
                    <td>{v.reason}</td>
                    <td className="muted">{v.recordedBy?.username ?? '—'}</td>
                  </tr>
                ))}
                {(me.visits ?? []).length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>no visits recorded</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="panel">
            <h2>Change history of my record</h2>
            <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
              Nothing is ever deleted — every change to your record is kept as a permanent history block.
            </div>
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>when</th><th>changed by</th><th>field</th><th>before → after</th><th>reason</th></tr></thead>
                <tbody>
                  {(me.history ?? []).slice().reverse().map((b) => Object.entries(b.changes).map(([field, ch]) => (
                    <tr key={`${b.seq}-${field}`}>
                      <td className="muted">{fmtIST(b.changedAt)}</td>
                      <td>{b.changedBy?.username ?? 'system'} <span className="muted">({b.changedBy?.role})</span></td>
                      <td>{field}</td>
                      <td><span className="warn">{JSON.stringify(ch.before)}</span> → <span className="ok">{JSON.stringify(ch.after)}</span></td>
                      <td className="muted">{b.reason}</td>
                    </tr>
                  )))}
                  {(me.history ?? []).length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>no changes recorded yet</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Hospital page — the formulary view for a single hospital. Both admin and
 * doctor see which drugs/medicines the hospital stocks, who provisioned each,
 * and can add drugs individually here or remove them. Opening a hospital is
 * available from the admin section and the doctor portal.
 */
function HospitalPage({ session, setSession, siteId, onBack }: {
  session: Session;
  setSession: (s: Session | null) => void;
  siteId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<HospitalDetailView | null>(null);
  const [drugName, setDrugName] = useState('');
  const [addError, setAddError] = useState('');
  const [adding, setAdding] = useState(false);
  const [drugSearch, setDrugSearch] = useState('');

  const canManage = session.role === 'admin' || session.role === 'doctor';

  const refresh = async () => {
    try {
      const res = await api(session, setSession, `/api/hospitals/${siteId}`);
      const body = await res.json();
      if (res.ok) setDetail(body);
    } catch {
      /* services starting up */
    }
  };

  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 5000);
    return () => clearInterval(iv);
  }, [session?.accessToken, siteId]);

  const addDrug = async () => {
    const name = drugName.trim();
    if (!name) { setAddError('drug name is required'); return; }
    setAdding(true);
    setAddError('');
    try {
      const res = await api(session, setSession, `/api/hospitals/${siteId}/drugs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drugName: name }),
      });
      const body = await res.json();
      if (!res.ok) { setAddError(body.error ?? 'failed to add drug'); return; }
      setDrugName('');
      void refresh();
    } finally { setAdding(false); }
  };

  const removeDrug = async (drugId: string) => {
    await api(session, setSession, `/api/hospitals/${siteId}/drugs/${drugId}`, { method: 'DELETE' });
    void refresh();
  };

  const drugs = (detail?.drugs ?? []).filter((d) =>
    d.drugName.toLowerCase().includes(drugSearch.trim().toLowerCase()));

  if (!detail) {
    return (
      <div className="app">
        <div className="back-link"><button onClick={onBack}>← back</button></div>
        <div className="panel"><h2>Loading hospital…</h2></div>
      </div>
    );
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div className="back-link" style={{ marginBottom: 0 }}><button onClick={onBack}>← back to dashboard</button></div>
        <ThemeToggle />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>{detail.name}</h1>
        <span className="badge low" style={{ justifySelf: 'end' }}>{detail.simulated ? 'SIMULATED' : 'REAL'} · {detail.siteId}</span>
      </div>
      <div className="subtitle">{detail.region} region · {detail.doctorCount} doctor{detail.doctorCount === 1 ? '' : 's'} · network {detail.network ? `${detail.network.baseLatencyMs}ms/${detail.network.jitterMs}ms/${(detail.network.dropRate * 100).toFixed(0)}%` : '—'}</div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Hospital formulary — drugs & medicines</h2>
          <div className="search-row">
            <input placeholder="search drugs…" value={drugSearch} onChange={(e) => setDrugSearch(e.target.value)} />
            <span className="muted" style={{ fontSize: 12 }}>{drugs.length} of {detail.drugs.length}</span>
          </div>
          <div style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>drug</th><th>added by</th><th>added at</th><th></th></tr>
              </thead>
              <tbody>
                {drugs.map((d) => (
                  <tr key={d.id}>
                    <td>{d.drugName}</td>
                    <td>{d.addedBy ? `${d.addedBy.username} (${d.addedBy.role})` : '—'}</td>
                    <td className="muted">{fmtIST(d.addedAt)}</td>
                    <td>
                      {canManage && (
                        <button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeDrug(d.id)}>remove</button>
                      )}
                    </td>
                  </tr>
                ))}
                {drugs.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>{detail.drugs.length === 0 ? 'no drugs provisioned yet' : 'no drugs match the search'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          {canManage ? (
            <div className="panel">
              <h2>Add drug to this hospital</h2>
              <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
                <input placeholder="drug / medicine name (e.g. warfarin)" value={drugName} onChange={(e) => setDrugName(e.target.value)} />
                <button className="primary" onClick={addDrug} disabled={adding}>{adding ? 'Adding…' : `Add to ${detail.name}`}</button>
                {addError && <div className="err" style={{ fontSize: 13 }}>{addError}</div>}
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Adding here provisions this drug only to {detail.name}. To provide a drug to several hospitals at once, use “provide to hospitals” on the dashboard.
                </div>
              </div>
            </div>
          ) : (
            <div className="panel"><h2>Formulary is read-only</h2><div className="muted" style={{ fontSize: 13 }}>Your role cannot modify the hospital formulary.</div></div>
          )}

          <div className="panel" style={{ marginTop: 16 }}>
            <h2>Doctors at this hospital ({detail.doctors.length})</h2>
            <table>
              <thead><tr><th>name</th><th>username</th></tr></thead>
              <tbody>
                {detail.doctors.map((d) => (
                  <tr key={d.userId}><td>{d.fullName ?? d.username}</td><td className="muted">{d.username}</td></tr>
                ))}
                {detail.doctors.length === 0 && <tr><td colSpan={2} style={{ color: 'var(--muted)' }}>no doctors affiliated</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Doctor portal — focused clinician view for publishing/updating drug-interaction
 * reference rules. One publish fans out to every hospital site automatically;
 * the global epoch advances only after ALL sites confirm receipt, so no
 * hospital ever evaluates a partial update.
 */
function DoctorPage({ session, setSession, onLogout, onOpenHospital, onOpenLogistics }: { session: Session; setSession: (s: Session | null) => void; onLogout: () => void; onOpenHospital: (siteId: string) => void; onOpenLogistics: () => void }) {
  const [sites, setSites] = useState<SiteState[]>([]);
  const [epoch, setEpoch] = useState<{ epochSeq: number; updatedAt: string }>({ epochSeq: 0, updatedAt: '' });
  const [rules, setRules] = useState<RuleVersionView[]>([]);
  const [hospitals, setHospitals] = useState<HospitalView[]>([]);
  const [drugA, setDrugA] = useState('');
  const [drugB, setDrugB] = useState('');
  const [severity, setSeverity] = useState('SEVERE');
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [formError, setFormError] = useState('');
  const [lastPublish, setLastPublish] = useState<{ ruleId: string; version: number; globalSeq: number } | null>(null);
  // search & filter
  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleSeverityFilter, setRuleSeverityFilter] = useState('ALL');
  const [rulePublisherFilter, setRulePublisherFilter] = useState('ALL');
  const [hospitalSearch, setHospitalSearch] = useState('');
  // provide drug to selected hospitals
  const [provideDrugName, setProvideDrugName] = useState('');
  const [provideSelected, setProvideSelected] = useState<Set<string>>(new Set());
  const [provideError, setProvideError] = useState('');
  const [provideBusy, setProvideBusy] = useState(false);
  const [provideResult, setProvideResult] = useState('');

  const refresh = async () => {
    try {
      const [sitesRes, wmRes, epochRes, rulesRes, hospitalsRes] = await Promise.all([
        api(session, setSession, '/api/sites').then((r) => r.json()),
        api(session, setSession, '/api/watermarks').then((r) => r.json()),
        api(session, setSession, '/api/epoch').then((r) => r.json()),
        api(session, setSession, '/api/reference/rules?latest=1').then((r) => r.json()),
        api(session, setSession, '/api/hospitals').then((r) => r.json()),
      ]);
      const wmById = new Map(
        (wmRes.watermarks ?? []).map((w: { siteId: string; watermarkSeq: number }) => [w.siteId, w.watermarkSeq]),
      );
      setSites(sitesRes.map((s: Record<string, unknown>) => ({
        siteId: s.siteId as string,
        watermark: wmById.get(s.siteId as string) ?? 0,
        baseLatencyMs: s.baseLatencyMs as number,
        jitterMs: s.jitterMs as number,
        dropRate: s.dropRate as number,
      })));
      setEpoch(epochRes);
      setRules(rulesRes);
      setHospitals(hospitalsRes);
    } catch {
      /* services starting up */
    }
  };

  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 3000);
    return () => clearInterval(iv);
  }, [session?.accessToken]);

  const publish = async () => {
    const a = drugA.trim().toLowerCase();
    const b = drugB.trim().toLowerCase();
    if (!a || !b) { setFormError('both drug names are required'); return; }
    if (a === b) { setFormError('the two drugs must be different'); return; }
    setPublishing(true);
    setFormError('');
    try {
      const res = await api(session, setSession, '/api/reference/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleId: `drug-interaction-${a}-${b}`,
          payload: { drugA: a, drugB: b, severity, note: note.trim() },
        }),
      });
      const body = await res.json();
      if (!res.ok) { setFormError(body.error ?? 'publish failed'); return; }
      setLastPublish({ ruleId: body.ruleId, version: body.version, globalSeq: body.globalSeq });
      void refresh();
    } finally { setPublishing(false); }
  };

  // latest version of each rule (rules arrive sorted by globalSeq desc from ?latest=1)
  const latestByRule = new Map<string, RuleVersionView>();
  for (const r of rules) latestByRule.set(r.ruleId, r);
  const currentRules = [...latestByRule.values()].sort((x, y) => y.globalSeq - x.globalSeq);

  const publishers = [...new Set(rules.map((r) => r.publishedBy?.username).filter(Boolean))] as string[];

  const filteredRules = currentRules.filter((r) => {
    const q = ruleSearch.trim().toLowerCase();
    const text = `${r.payload.drugA ?? ''} ${r.payload.drugB ?? ''} ${r.payload.note ?? ''} ${r.ruleId}`.toLowerCase();
    const matchesSearch = !q || text.includes(q);
    const matchesSeverity = ruleSeverityFilter === 'ALL' || (r.payload.severity ?? 'NONE') === ruleSeverityFilter;
    const matchesPublisher = rulePublisherFilter === 'ALL' || r.publishedBy?.username === rulePublisherFilter;
    return matchesSearch && matchesSeverity && matchesPublisher;
  });

  const filteredHospitals = hospitals.filter((h) => {
    const q = hospitalSearch.trim().toLowerCase();
    return !q || h.name.toLowerCase().includes(q) || h.siteId.toLowerCase().includes(q) || h.region.toLowerCase().includes(q);
  });

  const toggleProvide = (siteId: string) => {
    setProvideSelected((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId); else next.add(siteId);
      return next;
    });
  };

  const provideDrug = async () => {
    const name = provideDrugName.trim();
    if (!name) { setProvideError('drug name is required'); return; }
    if (provideSelected.size === 0) { setProvideError('select at least one hospital'); return; }
    setProvideBusy(true);
    setProvideError('');
    setProvideResult('');
    try {
      const res = await api(session, setSession, '/api/drugs/provide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drugName: name, hospitalIds: [...provideSelected] }),
      });
      const body = await res.json();
      if (!res.ok) { setProvideError(body.error ?? 'provide failed'); return; }
      setProvideResult(`provided '${body.drugName}' to ${body.provided} hospital${body.provided === 1 ? '' : 's'}${body.skipped.length ? ` — skipped ${body.skipped.length} (already stocked / not found)` : ''}`);
      setProvideDrugName('');
    } finally { setProvideBusy(false); }
  };

  const latestSeq = rules.length ? Math.max(...rules.map((r) => r.globalSeq)) : 0;
  const targetSeq = lastPublish?.globalSeq ?? latestSeq;
  const allReceived = sites.length > 0 && targetSeq > 0 && sites.every((s) => s.watermark >= targetSeq);
  const epochActive = targetSeq > 0 && epoch.epochSeq >= targetSeq;

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Doctor Portal — Drug Reference Updates</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={onOpenLogistics} title="Real-time medicine shipment tracking" style={{ padding: '4px 10px' }}>🚚 Logistics</button>
          <ThemeToggle />
          <span>{session.username} ({session.role}) ·</span>
          <button onClick={onLogout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">
        Publish or update a drug-interaction rule once — it fans out to every hospital automatically. The global active epoch (currently {epoch.epochSeq}) advances only after all sites confirm receipt, so no hospital evaluates a partial update.
      </div>

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Publish / update interaction rule</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="drug A (e.g. warfarin)" value={drugA} onChange={(e) => setDrugA(e.target.value)} />
            <input placeholder="drug B (e.g. aspirin)" value={drugB} onChange={(e) => setDrugB(e.target.value)} />
            <select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="NONE">NONE — clears the interaction</option>
              <option value="LOW">LOW</option>
              <option value="MODERATE">MODERATE</option>
              <option value="SEVERE">SEVERE</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
            <input placeholder="clinical note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="primary" onClick={publish} disabled={publishing}>{publishing ? 'Publishing…' : 'Publish to all hospitals'}</button>
            {formError && <div className="err" style={{ fontSize: 13 }}>{formError}</div>}
          </div>
          {lastPublish && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <div className="ok">Published {lastPublish.ruleId} v{lastPublish.version} (globalSeq {lastPublish.globalSeq})</div>
              <div style={{ marginTop: 4, color: 'var(--muted)' }}>
                {allReceived
                  ? (epochActive ? '✅ all hospitals received — epoch advanced, rule active everywhere' : 'all hospitals received — epoch advancing')
                  : 'propagating — epoch held until every hospital confirms receipt'}
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Current interaction rules — who added which drug</h2>
          <div className="search-row">
            <input placeholder="search drug / note / rule id…" value={ruleSearch} onChange={(e) => setRuleSearch(e.target.value)} />
            <select value={ruleSeverityFilter} onChange={(e) => setRuleSeverityFilter(e.target.value)}>
              <option value="ALL">all severities</option>
              <option value="NONE">NONE</option>
              <option value="LOW">LOW</option>
              <option value="MODERATE">MODERATE</option>
              <option value="SEVERE">SEVERE</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
            <select value={rulePublisherFilter} onChange={(e) => setRulePublisherFilter(e.target.value)}>
              <option value="ALL">all publishers</option>
              {publishers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setRuleSearch(''); setRuleSeverityFilter('ALL'); setRulePublisherFilter('ALL'); }}>clear</button>
          </div>
          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>interaction</th><th>severity</th><th>added by</th><th>v</th><th>seq</th><th></th></tr>
              </thead>
              <tbody>
                {filteredRules.map((r) => (
                  <tr key={r.ruleId}>
                    <td>{r.payload.drugA} + {r.payload.drugB}</td>
                    <td><span className={`badge ${SEVERITY_CLASS[r.payload.severity ?? 'NONE'] ?? 'none'}`}>{r.payload.severity ?? 'NONE'}</span></td>
                    <td>{r.publishedBy ? r.publishedBy.username : <span className="muted">system</span>}</td>
                    <td>{r.version}</td>
                    <td>{r.globalSeq}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => {
                      setDrugA(r.payload.drugA ?? '');
                      setDrugB(r.payload.drugB ?? '');
                      setSeverity(r.payload.severity ?? 'SEVERE');
                      setNote(r.payload.note ?? '');
                    }}>edit</button></td>
                  </tr>
                ))}
                {filteredRules.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>{currentRules.length === 0 ? 'no rules published yet' : 'no rules match the search/filter'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <h2>Hospital propagation status{targetSeq > 0 ? ` — rule seq ${targetSeq}` : ' — no rules published yet'}</h2>
        <div className="grid cols-3">
          {sites.map((s) => {
            const received = targetSeq > 0 && s.watermark >= targetSeq;
            return (
              <div key={s.siteId} className={`panel site-card ${targetSeq > 0 && !received ? 'lagging' : ''}`}>
                <h2>{s.siteId}</h2>
                <div className="row"><span className="k">watermark</span><span>{s.watermark}</span></div>
                <div className="row">
                  <span className="k">rule seq {targetSeq > 0 ? targetSeq : '—'}</span>
                  <span>{targetSeq > 0 ? (received ? <span className="ok">received ✓</span> : <span className="warn">propagating…</span>) : '—'}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ManagementHub session={session} setSession={setSession}>
        {(active) => (
          <>
            {active === 'patients' && <PatientsPanel session={session} setSession={setSession} />}
            {active === 'nurses' && <NursesPanel session={session} setSession={setSession} />}
            {active === 'hospitals' && (
              <div className="grid cols-2">
                <div className="panel">
                  <h2>Provide drug to hospitals</h2>
                  <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
                    <input placeholder="drug / medicine name (e.g. aspirin)" value={provideDrugName} onChange={(e) => setProvideDrugName(e.target.value)} />
                    <div className="search-row">
                      <input placeholder="filter hospitals…" value={hospitalSearch} onChange={(e) => setHospitalSearch(e.target.value)} style={{ minWidth: 140 }} />
                      <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setProvideSelected(new Set(filteredHospitals.map((h) => h.siteId)))}>select filtered</button>
                      <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setProvideSelected(new Set())}>clear selection</button>
                    </div>
                    <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
                      {filteredHospitals.map((h) => (
                        <label key={h.siteId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0', cursor: 'pointer' }}>
                          <input type="checkbox" checked={provideSelected.has(h.siteId)} onChange={() => toggleProvide(h.siteId)} />
                          <span>{h.name}</span>
                          <span className="muted" style={{ fontSize: 11 }}>{h.siteId}</span>
                        </label>
                      ))}
                      {filteredHospitals.length === 0 && <div className="muted" style={{ fontSize: 12 }}>no hospitals match the search</div>}
                    </div>
                    <div className="row"><span className="k">selected hospitals</span><span>{provideSelected.size}</span></div>
                    <button className="primary" onClick={provideDrug} disabled={provideBusy}>{provideBusy ? 'Providing…' : `Provide drug to ${provideSelected.size} hospital${provideSelected.size === 1 ? '' : 's'}`}</button>
                    {provideError && <div className="err" style={{ fontSize: 13 }}>{provideError}</div>}
                    {provideResult && <div className="ok" style={{ fontSize: 13 }}>{provideResult}</div>}
                    <div style={{ fontSize: 11, color: 'var(--muted)' }}>
                      Provision a drug only to the hospitals you pick. Open a hospital below to add drugs individually to that hospital.
                    </div>
                  </div>
                </div>

                <div className="panel">
                  <h2>Hospitals — open to manage formulary</h2>
                  <div className="search-row">
                    <input placeholder="search hospitals…" value={hospitalSearch} onChange={(e) => setHospitalSearch(e.target.value)} />
                    <span className="muted" style={{ fontSize: 12 }}>{filteredHospitals.length} of {hospitals.length}</span>
                  </div>
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    <table>
                      <thead><tr><th>hospital</th><th>site</th><th>region</th><th>doctors</th><th></th></tr></thead>
                      <tbody>
                        {filteredHospitals.map((h) => (
                          <tr key={h.siteId}>
                            <td>{h.name}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{h.siteId}</td>
                            <td>{h.region}</td>
                            <td>{h.doctorCount}</td>
                            <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => onOpenHospital(h.siteId)}>open</button></td>
                          </tr>
                        ))}
                        {filteredHospitals.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>{hospitals.length === 0 ? 'no hospitals' : 'no hospitals match the search'}</td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </ManagementHub>

      <div className="footer-note">
        Every update is versioned and hash-chained into the audit ledger. Hospital sites cache new versions as they arrive but evaluate only against the global active epoch (min watermark across all sites) — guaranteeing identical alerts at every hospital.
      </div>
    </div>
  );
}

type MgmtSection = 'patients' | 'nurses' | 'hospitals';

/**
 * Management hub — three big tiles (Patient / Nurse / Hospital Management)
 * matching the site-card style of the propagation status cards. Clicking a
 * tile expands that panel below; clicking again collapses it. Rendered for
 * admin and doctor only (they hold the management permissions).
 */
function ManagementHub({ session, setSession, children }: {
  session: Session;
  setSession: (s: Session | null) => void;
  children: (active: MgmtSection | null, setActive: (s: MgmtSection | null) => void) => React.ReactNode;
}) {
  const [active, setActive] = useState<MgmtSection | null>(null);
  const isAdmin = session.role === 'admin';
  const isDoctor = session.role === 'doctor';
  if (!isAdmin && !isDoctor) return null;

  const tiles: Array<{ key: MgmtSection; title: string; desc: string; icon: string }> = [
    { key: 'patients', title: 'Patient Management', desc: 'create patients, edit conditions & medication, record visits, view change history', icon: '🧑‍⚕️' },
    { key: 'nurses', title: 'Nurse Management', desc: 'create nurse accounts, assign hospitals, remove access', icon: '👩‍⚕️' },
    {
      key: 'hospitals',
      title: 'Hospital Management',
      desc: isAdmin
        ? 'add hospitals, generate simulated fleet for scale testing, provide drugs to hospitals'
        : 'provide drugs to chosen hospitals, open hospital formulary pages',
      icon: '🏥',
    },
  ];

  return (
    <div style={{ marginBottom: 16 }}>
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        {tiles.map((t) => (
          <button
            key={t.key}
            className={`mgmt-tile ${active === t.key ? 'active' : ''}`}
            onClick={() => setActive(active === t.key ? null : t.key)}
          >
            <div className="tile-title">{t.icon} {t.title}</div>
            <div className="tile-desc">{t.desc}</div>
          </button>
        ))}
      </div>
      {active && children(active, setActive)}
    </div>
  );
}

interface NurseViewT {
  userId: string;
  username: string;
  role: string;
  hospitalId?: string;
  fullName?: string;
  hospitalName?: string | null;
}

/**
 * Nurses panel — admin & doctor create nurse accounts (login email +
 * password + assigned hospital), list them, and remove them. Nurses use
 * these credentials for the masked-patient-lookup dashboard.
 */
function NursesPanel({ session, setSession }: { session: Session; setSession: (s: Session | null) => void }) {
  const [nurses, setNurses] = useState<NurseViewT[]>([]);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [hospitalId, setHospitalId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  const canManage = session.role === 'admin' || session.role === 'doctor';

  const refresh = async () => {
    if (!canManage) return;
    try {
      const res = await api(session, setSession, '/api/nurses');
      const body = await res.json();
      if (res.ok) setNurses(body);
    } catch { /* starting up */ }
  };

  useEffect(() => {
    void refresh();
    const iv = setInterval(refresh, 8000);
    return () => clearInterval(iv);
  }, [session?.accessToken]);

  const createNurse = async () => {
    const mail = email.trim();
    if (!mail.includes('@')) { setError('a valid login email is required'); return; }
    if (password.length < 8) { setError('password must be at least 8 characters'); return; }
    if (!hospitalId) { setError('choose the assigned hospital'); return; }
    setBusy(true);
    setError('');
    try {
      const res = await api(session, setSession, '/api/nurses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: mail, password, fullName: fullName || undefined, hospitalId }),
      });
      const body = await res.json();
      if (!res.ok) { setError(body.error ?? 'failed to create nurse'); return; }
      setCreated({ email: mail, password });
      setEmail(''); setPassword(''); setFullName('');
      void refresh();
    } finally { setBusy(false); }
  };

  const removeNurse = async (userId: string) => {
    await api(session, setSession, `/api/nurses/${userId}`, { method: 'DELETE' });
    void refresh();
  };

  if (!canManage) return null;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Nurses ({nurses.length})</h2>
      <div className="grid cols-2">
        <div>
          <h2>Create nurse account</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="nurse login email (e.g. mia.hart@demo.health)" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input placeholder="password (min 8 chars)" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input placeholder="full name (optional, e.g. Mia Hart)" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            <HospitalSelectForNurses value={hospitalId} onChange={setHospitalId} session={session} setSession={setSession} />
            <button className="primary" onClick={createNurse} disabled={busy}>{busy ? 'Creating…' : 'Create nurse'}</button>
            {error && <div className="err" style={{ fontSize: 13 }}>{error}</div>}
          </div>
          {created && (
            <div className="panel" style={{ marginTop: 12, borderColor: 'var(--green)' }}>
              <h2>Nurse created — credentials (shown once)</h2>
              <div className="event-log"><div>login: <b>{created.email}</b> / password: <b>{created.password}</b></div></div>
              <button style={{ marginTop: 8 }} onClick={() => setCreated(null)}>close</button>
            </div>
          )}
        </div>
        <div>
          <h2>Nurse accounts</h2>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>name</th><th>login email</th><th>hospital</th><th></th></tr></thead>
              <tbody>
                {nurses.map((n) => (
                  <tr key={n.userId}>
                    <td>{n.fullName ?? '—'}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{n.username}</td>
                    <td>{n.hospitalName ?? n.hospitalId ?? '—'}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeNurse(n.userId)}>remove</button></td>
                  </tr>
                ))}
                {nurses.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>no nurse accounts yet</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Small helper: hospital dropdown for the nurse create form (fetches hospitals once). */
function HospitalSelectForNurses({ value, onChange, session, setSession }: { value: string; onChange: (v: string) => void; session: Session; setSession: (s: Session | null) => void }) {
  const [hospitals, setHospitals] = useState<HospitalView[]>([]);
  useEffect(() => {
    void (async () => {
      try {
        const res = await api(session, setSession, '/api/hospitals');
        const body = await res.json();
        if (res.ok) setHospitals(body);
      } catch { /* starting up */ }
    })();
  }, [session?.accessToken]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">assigned hospital…</option>
      {hospitals.map((h) => <option key={h.siteId} value={h.siteId}>{h.name} ({h.siteId})</option>)}
    </select>
  );
}

/**
 * Patients panel — shared by the admin dashboard and doctor portal.
 * Doctors/admins create patients (with portal login), edit any field
 * (every change is history-blocked, nothing hard-deleted), record hospital
 * visits, deactivate/reactivate, and inspect the full change history.
 */
function PatientsPanel({ session, setSession }: { session: Session; setSession: (s: Session | null) => void }) {
  const [patientsList, setPatientsList] = useState<PatientViewT[]>([]);
  const [allHospitals, setAllHospitals] = useState<HospitalView[]>([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<PatientViewT | null>(null);
  // create form
  const [pFirst, setPFirst] = useState('');
  const [pLast, setPLast] = useState('');
  const [pDob, setPDob] = useState('');
  const [pGender, setPGender] = useState('female');
  const [pDisease, setPDisease] = useState('');
  const [pDrugs, setPDrugs] = useState('');
  const [pEmail, setPEmail] = useState('');
  const [pPassword, setPPassword] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [createdCreds, setCreatedCreds] = useState<{ patientRef: string; email: string; password: string } | null>(null);
  // edit form
  const [eDisease, setEDisease] = useState('');
  const [eDrugs, setEDrugs] = useState('');
  const [eReason, setEReason] = useState('');
  const [editError, setEditError] = useState('');
  const [editing, setEditing] = useState(false);
  // visit form
  const [vHospital, setVHospital] = useState('');
  const [vReason, setVReason] = useState('');
  const [visitError, setVisitError] = useState('');
  const [visiting, setVisiting] = useState(false);

  const canManage = session.role === 'admin' || session.role === 'doctor';

  const refreshList = async () => {
    if (!canManage) return;
    try {
      const [pRes, hRes] = await Promise.all([
        api(session, setSession, '/api/patients').then((r) => r.json().then((b) => ({ ok: r.ok, body: b }))),
        api(session, setSession, '/api/hospitals').then((r) => r.json().then((b) => ({ ok: r.ok, body: b }))),
      ]);
      if (pRes.ok) setPatientsList(pRes.body);
      if (hRes.ok) setAllHospitals(hRes.body);
    } catch { /* starting up */ }
  };

  const refreshDetail = async (patientId: string) => {
    try {
      const res = await api(session, setSession, `/api/patients/${patientId}`);
      const body = await res.json();
      if (res.ok) {
        setSelected(body);
        setEDisease(body.data.disease);
        setEDrugs(body.data.drugs.join(', '));
      }
    } catch { /* starting up */ }
  };

  useEffect(() => {
    void refreshList();
    const iv = setInterval(refreshList, 8000);
    return () => clearInterval(iv);
  }, [session?.accessToken]);

  useEffect(() => {
    if (selected) void refreshDetail(selected.patientId);
  }, [selected?.patientId]);

  const createPatient = async () => {
    if (!pFirst.trim() || !pLast.trim()) { setCreateError('first and last name are required'); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(pDob)) { setCreateError('date of birth must be YYYY-MM-DD'); return; }
    if (!pEmail.includes('@')) { setCreateError('a valid portal email is required'); return; }
    if (pPassword.length < 8) { setCreateError('portal password must be at least 8 characters'); return; }
    setCreating(true);
    setCreateError('');
    try {
      const res = await api(session, setSession, '/api/patients', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          firstName: pFirst,
          lastName: pLast,
          dob: pDob,
          gender: pGender,
          disease: pDisease,
          drugs: pDrugs.split(',').map((s) => s.trim()).filter(Boolean),
          email: pEmail,
          password: pPassword,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setCreateError(body.error ?? 'failed to create patient'); return; }
      setCreatedCreds({ patientRef: body.data.patientRef, email: pEmail, password: pPassword });
      setPFirst(''); setPLast(''); setPDob(''); setPDisease(''); setPDrugs(''); setPEmail(''); setPPassword('');
      void refreshList();
    } finally { setCreating(false); }
  };

  const saveEdit = async () => {
    if (!selected) return;
    setEditing(true);
    setEditError('');
    try {
      const res = await api(session, setSession, `/api/patients/${selected.patientId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          disease: eDisease,
          drugs: eDrugs.split(',').map((s) => s.trim()).filter(Boolean),
          reason: eReason || undefined,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setEditError(body.error ?? 'update failed'); return; }
      setEReason('');
      void refreshDetail(selected.patientId);
      void refreshList();
    } finally { setEditing(false); }
  };

  const recordVisit = async () => {
    if (!selected || !vHospital) { setVisitError('choose a hospital'); return; }
    setVisiting(true);
    setVisitError('');
    try {
      const res = await api(session, setSession, `/api/patients/${selected.patientId}/visits`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ hospitalId: vHospital, reason: vReason || 'visit' }),
      });
      const body = await res.json();
      if (!res.ok) { setVisitError(body.error ?? 'failed to record visit'); return; }
      setVReason('');
      void refreshDetail(selected.patientId);
      void refreshList();
    } finally { setVisiting(false); }
  };

  const setStatus = async (action: 'deactivate' | 'reactivate') => {
    if (!selected) return;
    await api(session, setSession, `/api/patients/${selected.patientId}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: `${action}d from dashboard` }),
    });
    void refreshDetail(selected.patientId);
    void refreshList();
  };

  if (!canManage) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? patientsList.filter((p) =>
        `${p.data.patientRef} ${p.data.firstName} ${p.data.lastName} ${p.data.disease} ${p.email} ${p.data.drugs.join(' ')}`.toLowerCase().includes(q))
    : patientsList;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Patients ({filtered.length}{filtered.length !== patientsList.length ? ` of ${patientsList.length}` : ''})</h2>

      {createdCreds && (
        <div className="panel" style={{ marginBottom: 12, borderColor: 'var(--green)' }}>
          <h2>Patient created — portal credentials (shown once)</h2>
          <div className="event-log">
            <div>{createdCreds.patientRef} — login email: <b>{createdCreds.email}</b> / password: <b>{createdCreds.password}</b></div>
          </div>
          <button style={{ marginTop: 8 }} onClick={() => setCreatedCreds(null)}>close</button>
        </div>
      )}

      <div className="grid cols-2">
        <div>
          <h2>Create patient (with portal login)</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <div className="row" style={{ gap: 8 }}>
              <input placeholder="first name" value={pFirst} onChange={(e) => setPFirst(e.target.value)} style={{ flex: 1 }} />
              <input placeholder="last name" value={pLast} onChange={(e) => setPLast(e.target.value)} style={{ flex: 1 }} />
            </div>
            <div className="row" style={{ gap: 8 }}>
              <input placeholder="date of birth (YYYY-MM-DD)" value={pDob} onChange={(e) => setPDob(e.target.value)} style={{ flex: 1 }} />
              <select value={pGender} onChange={(e) => setPGender(e.target.value)}>
                <option value="female">female</option>
                <option value="male">male</option>
                <option value="other">other</option>
                <option value="unspecified">unspecified</option>
              </select>
            </div>
            <input placeholder="disease / condition" value={pDisease} onChange={(e) => setPDisease(e.target.value)} />
            <input placeholder="drugs (comma-separated)" value={pDrugs} onChange={(e) => setPDrugs(e.target.value)} />
            <input placeholder="portal login email (e.g. jane.doe@mail.com)" value={pEmail} onChange={(e) => setPEmail(e.target.value)} />
            <input placeholder="portal password (min 8 chars)" type="password" value={pPassword} onChange={(e) => setPPassword(e.target.value)} />
            <button className="primary" onClick={createPatient} disabled={creating}>{creating ? 'Creating…' : 'Create patient'}</button>
            {createError && <div className="err" style={{ fontSize: 13 }}>{createError}</div>}
          </div>
        </div>

        <div>
          <h2>Patient records</h2>
          <div className="search-row">
            <input placeholder="search name / ID / disease / drug…" value={search} onChange={(e) => setSearch(e.target.value)} />
            <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setSearch('')}>clear</button>
          </div>
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            <table>
              <thead><tr><th>ID</th><th>name</th><th>age</th><th>disease</th><th>visits</th><th>status</th><th></th></tr></thead>
              <tbody>
                {filtered.map((p) => (
                  <tr key={p.patientId} style={{ cursor: 'pointer' }} onClick={() => void refreshDetail(p.patientId)}>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{p.data.patientRef}</td>
                    <td>{p.data.firstName} {p.data.lastName}</td>
                    <td>{calcAge(p.data.dob)}</td>
                    <td>{p.data.disease}</td>
                    <td>{p.visitCount ?? 0}</td>
                    <td>{p.status === 'active' ? <span className="ok">active</span> : <span className="err">deactivated</span>}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void refreshDetail(p.patientId); }}>open</button></td>
                  </tr>
                ))}
                {filtered.length === 0 && <tr><td colSpan={7} style={{ color: 'var(--muted)' }}>{patientsList.length === 0 ? 'no patients yet' : 'no patients match the search'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selected && (
        <div className="panel" style={{ marginTop: 16, borderColor: 'var(--accent)' }}>
          <h2>{selected.data.patientRef} — {selected.data.firstName} {selected.data.lastName} <span className="badge none" style={{ marginLeft: 8 }}>{selected.status}</span></h2>
          <div className="grid cols-3">
            <div>
              <div className="row"><span className="k">patient ID</span><span style={{ fontFamily: 'ui-monospace, monospace' }}>{selected.data.patientRef}</span></div>
              <div className="row"><span className="k">DOB / age</span><span>{selected.data.dob} ({calcAge(selected.data.dob)}y)</span></div>
              <div className="row"><span className="k">gender</span><span>{selected.data.gender}</span></div>
              <div className="row" style={{ alignItems: 'flex-start' }}><span className="k">drugs</span>
                <span style={{ textAlign: 'right' }}>
                  {selected.data.drugs.length > 0
                    ? selected.data.drugs.map((d) => <span key={d} className="badge low" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{d}</span>)
                    : <span className="muted">none</span>}
                </span>
              </div>
              <div className="row" style={{ alignItems: 'flex-start' }}><span className="k">interactions</span>
                <span style={{ textAlign: 'right' }}>
                  {(selected.data.interactions ?? []).length > 0
                    ? selected.data.interactions!.map((i) => <div key={i} className="badge severe" style={{ display: 'inline-block', margin: '2px 0 2px 6px' }}>{i}</div>)
                    : <span className="ok">none known</span>}
                </span>
              </div>
              <div className="row"><span className="k">portal email</span><span>{selected.email}</span></div>
              <div className="row"><span className="k">created by</span><span>{selected.createdBy?.username ?? '—'}</span></div>
              <div className="controls">
                {selected.status === 'active'
                  ? <button onClick={() => void setStatus('deactivate')}>deactivate</button>
                  : <button onClick={() => void setStatus('reactivate')}>reactivate</button>}
              </div>
            </div>
            <div>
              <h2>Update condition & medication</h2>
              <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
                <input placeholder="disease / condition" value={eDisease} onChange={(e) => setEDisease(e.target.value)} />
                <input placeholder="drugs (comma-separated)" value={eDrugs} onChange={(e) => setEDrugs(e.target.value)} />
                <input placeholder="reason for change (recorded in history)" value={eReason} onChange={(e) => setEReason(e.target.value)} />
                <button className="primary" onClick={saveEdit} disabled={editing}>{editing ? 'Saving…' : 'Save changes'}</button>
                {editError && <div className="err" style={{ fontSize: 13 }}>{editError}</div>}
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>Every change is stored as a permanent history block — before and after values.</div>
              </div>
            </div>
            <div>
              <h2>Record hospital visit</h2>
              <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
                <select value={vHospital} onChange={(e) => setVHospital(e.target.value)}>
                  <option value="">choose hospital…</option>
                  {allHospitals.map((h) => <option key={h.siteId} value={h.siteId}>{h.name} ({h.siteId})</option>)}
                </select>
                <input placeholder="reason for visit" value={vReason} onChange={(e) => setVReason(e.target.value)} />
                <button className="primary" onClick={recordVisit} disabled={visiting}>{visiting ? 'Recording…' : 'Record visit'}</button>
                {visitError && <div className="err" style={{ fontSize: 13 }}>{visitError}</div>}
              </div>
            </div>
          </div>

          <div className="grid cols-2" style={{ marginTop: 12 }}>
            <div>
              <h2>Visits ({(selected.visits ?? []).length})</h2>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>hospital</th><th>when</th><th>reason</th><th>by</th></tr></thead>
                  <tbody>
                    {(selected.visits ?? []).map((v) => (
                      <tr key={v.visitId}>
                        <td>{v.hospitalName ?? v.hospitalId}</td>
                        <td className="muted">{fmtIST(v.visitedAt)}</td>
                        <td>{v.reason}</td>
                        <td className="muted">{v.recordedBy?.username ?? '—'}</td>
                      </tr>
                    ))}
                    {(selected.visits ?? []).length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>no visits recorded</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <h2>Change history (blocks)</h2>
              <div style={{ maxHeight: 200, overflowY: 'auto' }}>
                <table>
                  <thead><tr><th>when</th><th>by</th><th>field</th><th>before → after</th><th>reason</th></tr></thead>
                  <tbody>
                    {(selected.history ?? []).slice().reverse().map((b) => Object.entries(b.changes).map(([field, ch]) => (
                      <tr key={`${b.seq}-${field}`}>
                        <td className="muted">{fmtIST(b.changedAt)}</td>
                        <td>{b.changedBy?.username ?? 'system'}</td>
                        <td>{field}</td>
                        <td><span className="warn">{JSON.stringify(ch.before)}</span> → <span className="ok">{JSON.stringify(ch.after)}</span></td>
                        <td className="muted">{b.reason}</td>
                      </tr>
                    )))}
                    {(selected.history ?? []).length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>no changes yet</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Admin management section — hospitals & doctors CRUD plus simulated
 * hospital generation for scalability testing, drug distribution across
 * hospitals, and a full rules view with attribution (who added which drug).
 * Rendered for admin only (backed by hospitals:manage / users:manage).
 */
function AdminSection({ session, setSession, onRefresh, onOpenHospital }: { session: Session; setSession: (s: Session | null) => void; onRefresh: () => void; onOpenHospital: (siteId: string) => void }) {
  const [hospitals, setHospitals] = useState<HospitalView[]>([]);
  const [doctors, setDoctors] = useState<DoctorView[]>([]);
  const [rules, setRules] = useState<RuleVersionView[]>([]);
  const [hName, setHName] = useState('');
  const [hSiteId, setHSiteId] = useState('');
  const [hRegion, setHRegion] = useState('');
  const [hError, setHError] = useState('');
  const [addingHospital, setAddingHospital] = useState(false);
  const [simCount, setSimCount] = useState(50);
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState('');
  const [simResult, setSimResult] = useState<string>('');
  const [docUsername, setDocUsername] = useState('');
  const [docPassword, setDocPassword] = useState('');
  const [docFullName, setDocFullName] = useState('');
  const [docHospitalId, setDocHospitalId] = useState('');
  const [docError, setDocError] = useState('');
  const [addingDoctor, setAddingDoctor] = useState(false);
  const [showPasswords, setShowPasswords] = useState<{ title: string; rows: Array<{ username: string; password: string; fullName: string }> } | null>(null);
  // search & filter
  const [hospitalSearch, setHospitalSearch] = useState('');
  const [hospitalTypeFilter, setHospitalTypeFilter] = useState<'all' | 'real' | 'sim'>('all');
  const [doctorSearch, setDoctorSearch] = useState('');
  const [ruleSearch, setRuleSearch] = useState('');
  const [ruleSeverityFilter, setRuleSeverityFilter] = useState('ALL');
  const [rulePublisherFilter, setRulePublisherFilter] = useState('ALL');
  // drug distribution
  const [provideDrugName, setProvideDrugName] = useState('');
  const [provideSelected, setProvideSelected] = useState<Set<string>>(new Set());
  const [provideError, setProvideError] = useState('');
  const [provideBusy, setProvideBusy] = useState(false);
  const [provideResult, setProvideResult] = useState('');

  const isAdmin = session.role === 'admin';

  const refreshAdmin = async () => {
    if (!isAdmin) return;
    try {
      const [hRes, dRes, rRes] = await Promise.all([
        api(session, setSession, '/api/hospitals').then((r) => r.json()),
        api(session, setSession, '/api/doctors').then((r) => r.json()),
        api(session, setSession, '/api/reference/rules?latest=1').then((r) => r.json()),
      ]);
      setHospitals(hRes);
      setDoctors(dRes);
      setRules(rRes);
    } catch {
      /* services starting up */
    }
  };

  useEffect(() => {
    void refreshAdmin();
    const iv = setInterval(refreshAdmin, 5000);
    return () => clearInterval(iv);
  }, [session?.accessToken]);

  const addHospital = async () => {
    const name = hName.trim();
    if (!name) { setHError('hospital name is required'); return; }
    setAddingHospital(true);
    setHError('');
    try {
      const res = await api(session, setSession, '/api/hospitals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
          ...(hSiteId.trim() ? { siteId: hSiteId.trim() } : {}),
          ...(hRegion.trim() ? { region: hRegion.trim() } : {}),
        }),
      });
      const body = await res.json();
      if (!res.ok) { setHError(body.error ?? 'failed to add hospital'); return; }
      setHName(''); setHSiteId(''); setHRegion('');
      void refreshAdmin();
      onRefresh();
    } finally { setAddingHospital(false); }
  };

  const removeHospital = async (siteId: string) => {
    await api(session, setSession, `/api/hospitals/${siteId}`, { method: 'DELETE' });
    setProvideSelected((prev) => { const next = new Set(prev); next.delete(siteId); return next; });
    void refreshAdmin();
    onRefresh();
  };

  const generateSimulated = async () => {
    if (!Number.isInteger(simCount) || simCount < 1 || simCount > 1000) {
      setSimError('count must be an integer between 1 and 1000');
      return;
    }
    setSimBusy(true);
    setSimError('');
    setSimResult('');
    try {
      const res = await api(session, setSession, '/api/hospitals/simulated', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: simCount }),
      });
      const body = await res.json();
      if (!res.ok) { setSimError(body.error ?? 'generation failed'); return; }
      setSimResult(`generated ${body.count} simulated hospitals in ${body.replayMs}ms (incl. rule replay) — total hospitals: ${hospitals.length + body.count}`);
      void refreshAdmin();
      onRefresh();
    } finally { setSimBusy(false); }
  };

  const addDoctor = async () => {
    const username = docUsername.trim();
    const hospitalId = docHospitalId || hospitals[0]?.siteId;
    if (!/^[a-z0-9]([a-z0-9.-]{1,30}[a-z0-9])?$/.test(username)) { setDocError('username: 3-32 chars, lowercase letters/numbers/dots/dashes'); return; }
    if (docPassword.length < 8) { setDocError('password must be at least 8 characters'); return; }
    if (!hospitalId) { setDocError('add a hospital first'); return; }
    setAddingDoctor(true);
    setDocError('');
    try {
      const res = await api(session, setSession, '/api/doctors', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          username,
          password: docPassword,
          ...(docFullName.trim() ? { fullName: docFullName.trim() } : {}),
          hospitalId,
        }),
      });
      const body = await res.json();
      if (!res.ok) { setDocError(body.error ?? 'failed to add doctor'); return; }
      setDocUsername(''); setDocPassword(''); setDocFullName('');
      void refreshAdmin();
    } finally { setAddingDoctor(false); }
  };

  const removeDoctor = async (userId: string) => {
    await api(session, setSession, `/api/doctors/${userId}`, { method: 'DELETE' });
    void refreshAdmin();
  };

  const generateDoctors = async () => {
    setSimBusy(true);
    setSimError('');
    try {
      const res = await api(session, setSession, '/api/doctors/simulated', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ count: Math.max(1, Math.min(hospitals.length, 1000)) }),
      });
      const body = await res.json();
      if (!res.ok) { setSimError(body.error ?? 'doctor generation failed'); return; }
      setShowPasswords({ title: `Generated ${body.count} simulated doctor${body.count === 1 ? '' : 's'}`, rows: body.created });
      void refreshAdmin();
    } finally { setSimBusy(false); }
  };

  const toggleProvide = (siteId: string) => {
    setProvideSelected((prev) => {
      const next = new Set(prev);
      if (next.has(siteId)) next.delete(siteId); else next.add(siteId);
      return next;
    });
  };

  const provideDrug = async () => {
    const name = provideDrugName.trim();
    if (!name) { setProvideError('drug name is required'); return; }
    if (provideSelected.size === 0) { setProvideError('select at least one hospital'); return; }
    setProvideBusy(true);
    setProvideError('');
    setProvideResult('');
    try {
      const res = await api(session, setSession, '/api/drugs/provide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ drugName: name, hospitalIds: [...provideSelected] }),
      });
      const body = await res.json();
      if (!res.ok) { setProvideError(body.error ?? 'provide failed'); return; }
      setProvideResult(`provided '${body.drugName}' to ${body.provided} hospital${body.provided === 1 ? '' : 's'}${body.skipped.length ? ` — skipped ${body.skipped.length} (already stocked / not found)` : ''}`);
      setProvideDrugName('');
      void refreshAdmin();
    } finally { setProvideBusy(false); }
  };

  if (!isAdmin) return null;

  // ── filtered views ────────────────────────────────────────────────────────
  const filteredHospitals = hospitals.filter((h) => {
    const q = hospitalSearch.trim().toLowerCase();
    const matchesSearch = !q || h.name.toLowerCase().includes(q) || h.siteId.toLowerCase().includes(q) || h.region.toLowerCase().includes(q);
    const matchesType = hospitalTypeFilter === 'all' || (hospitalTypeFilter === 'sim') === h.simulated;
    return matchesSearch && matchesType;
  });

  const filteredDoctors = doctors.filter((d) => {
    const q = doctorSearch.trim().toLowerCase();
    return !q ||
      d.username.toLowerCase().includes(q) ||
      (d.fullName ?? '').toLowerCase().includes(q) ||
      (d.hospitalName ?? d.hospitalId ?? '').toLowerCase().includes(q);
  });

  const publishers = [...new Set(rules.map((r) => r.publishedBy?.username).filter(Boolean))] as string[];

  const filteredRules = rules.filter((r) => {
    const q = ruleSearch.trim().toLowerCase();
    const text = `${r.payload.drugA ?? ''} ${r.payload.drugB ?? ''} ${r.payload.note ?? ''} ${r.ruleId}`.toLowerCase();
    const matchesSearch = !q || text.includes(q);
    const matchesSeverity = ruleSeverityFilter === 'ALL' || (r.payload.severity ?? 'NONE') === ruleSeverityFilter;
    const matchesPublisher = rulePublisherFilter === 'ALL' || r.publishedBy?.username === rulePublisherFilter;
    return matchesSearch && matchesSeverity && matchesPublisher;
  });

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h2>Admin — hospitals & doctors</h2>
      <div className="grid cols-3">
        <div>
          <h2>Add hospital</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="hospital name (e.g. Lakeside General)" value={hName} onChange={(e) => setHName(e.target.value)} />
            <input placeholder="site id (optional — derived from name)" value={hSiteId} onChange={(e) => setHSiteId(e.target.value)} />
            <input placeholder="region (optional)" value={hRegion} onChange={(e) => setHRegion(e.target.value)} />
            <button className="primary" onClick={addHospital} disabled={addingHospital}>{addingHospital ? 'Adding…' : 'Add hospital'}</button>
            {hError && <div className="err" style={{ fontSize: 13 }}>{hError}</div>}
          </div>
        </div>
        <div>
          <h2>Generate simulated hospitals</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <div className="row"><span className="k">number of hospitals to add</span></div>
            <input type="number" min={1} max={1000} value={simCount} onChange={(e) => setSimCount(Number(e.target.value))} style={{ width: '100%' }} />
            <button className="primary" onClick={generateSimulated} disabled={simBusy}>{simBusy ? 'Generating…' : `Generate ${simCount} simulated hospitals`}</button>
            {simError && <div className="err" style={{ fontSize: 13 }}>{simError}</div>}
            {simResult && <div className="ok" style={{ fontSize: 13 }}>{simResult}</div>}
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Each simulated hospital runs an in-process agent with a randomized network profile — use it to stress fan-out, watermark convergence, and epoch gating at scale.
            </div>
          </div>
        </div>
        <div>
          <h2>Add doctor</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="username (e.g. s.chen)" value={docUsername} onChange={(e) => setDocUsername(e.target.value)} />
            <input placeholder="password (min 8 chars)" type="password" value={docPassword} onChange={(e) => setDocPassword(e.target.value)} />
            <input placeholder="full name (optional, e.g. Dr. Sarah Chen)" value={docFullName} onChange={(e) => setDocFullName(e.target.value)} />
            <select value={docHospitalId} onChange={(e) => setDocHospitalId(e.target.value)}>
              <option value="">hospital — first available</option>
              {hospitals.map((h) => <option key={h.siteId} value={h.siteId}>{h.name} ({h.siteId})</option>)}
            </select>
            <button className="primary" onClick={addDoctor} disabled={addingDoctor}>{addingDoctor ? 'Adding…' : 'Add doctor'}</button>
            {docError && <div className="err" style={{ fontSize: 13 }}>{docError}</div>}
          </div>
        </div>
      </div>

      {showPasswords && (
        <div className="panel" style={{ marginTop: 12, borderColor: 'var(--green)' }}>
          <h2>{showPasswords.title} — credentials shown once</h2>
          <div className="event-log">
            {showPasswords.rows.map((r) => (
              <div key={r.username}>{r.fullName} — {r.username} / {r.password}</div>
            ))}
          </div>
          <button style={{ marginTop: 8 }} onClick={() => setShowPasswords(null)}>close</button>
        </div>
      )}

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div>
          <h2>Hospitals ({filteredHospitals.length}{filteredHospitals.length !== hospitals.length ? ` of ${hospitals.length}` : ''})</h2>
          <div className="search-row">
            <input placeholder="search name / site id / region…" value={hospitalSearch} onChange={(e) => setHospitalSearch(e.target.value)} />
            <select value={hospitalTypeFilter} onChange={(e) => setHospitalTypeFilter(e.target.value as 'all' | 'real' | 'sim')}>
              <option value="all">all types</option>
              <option value="real">real only</option>
              <option value="sim">simulated only</option>
            </select>
            <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setHospitalSearch(''); setHospitalTypeFilter('all'); }}>clear</button>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>name</th><th>site</th><th>region</th><th>doctors</th><th>type</th><th></th></tr>
              </thead>
              <tbody>
                {filteredHospitals.map((h) => (
                  <tr key={h.siteId}>
                    <td><a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => { e.preventDefault(); onOpenHospital(h.siteId); }}>{h.name}</a></td>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{h.siteId}</td>
                    <td>{h.region}</td>
                    <td>{h.doctorCount}</td>
                    <td>{h.simulated ? <span className="badge low">SIM</span> : <span className="badge none">REAL</span>}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeHospital(h.siteId)}>remove</button></td>
                  </tr>
                ))}
                {filteredHospitals.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>{hospitals.length === 0 ? 'no hospitals' : 'no hospitals match the search/filter'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>Doctors ({filteredDoctors.length}{filteredDoctors.length !== doctors.length ? ` of ${doctors.length}` : ''})
            <button style={{ padding: '2px 8px', fontSize: 11, marginLeft: 8, textTransform: 'none' }} onClick={generateDoctors} disabled={simBusy || hospitals.length === 0}>generate test doctors</button>
          </h2>
          <div className="search-row">
            <input placeholder="search name / username / hospital…" value={doctorSearch} onChange={(e) => setDoctorSearch(e.target.value)} />
            <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setDoctorSearch('')}>clear</button>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>name</th><th>username</th><th>hospital</th><th></th></tr>
              </thead>
              <tbody>
                {filteredDoctors.map((d) => (
                  <tr key={d.userId}>
                    <td>{d.fullName ?? d.username}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{d.username}</td>
                    <td>{d.hospitalName ?? d.hospitalId ?? '—'}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeDoctor(d.userId)}>remove</button></td>
                  </tr>
                ))}
                {filteredDoctors.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>{doctors.length === 0 ? 'no doctors' : 'no doctors match the search'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 16 }}>
        <div className="panel" style={{ border: 0, padding: 0 }}>
          <h2>Interaction rules — who added which drug ({filteredRules.length}{filteredRules.length !== rules.length ? ` of ${rules.length}` : ''})</h2>
          <div className="search-row">
            <input placeholder="search drug / note / rule id…" value={ruleSearch} onChange={(e) => setRuleSearch(e.target.value)} />
            <select value={ruleSeverityFilter} onChange={(e) => setRuleSeverityFilter(e.target.value)}>
              <option value="ALL">all severities</option>
              <option value="NONE">NONE</option>
              <option value="LOW">LOW</option>
              <option value="MODERATE">MODERATE</option>
              <option value="SEVERE">SEVERE</option>
              <option value="CRITICAL">CRITICAL</option>
            </select>
            <select value={rulePublisherFilter} onChange={(e) => setRulePublisherFilter(e.target.value)}>
              <option value="ALL">all publishers</option>
              {publishers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
            <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => { setRuleSearch(''); setRuleSeverityFilter('ALL'); setRulePublisherFilter('ALL'); }}>clear</button>
          </div>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>interaction</th><th>severity</th><th>added by</th><th>v</th><th>seq</th></tr>
              </thead>
              <tbody>
                {filteredRules.map((r) => (
                  <tr key={r.ruleId}>
                    <td>{r.payload.drugA} + {r.payload.drugB}</td>
                    <td><span className={`badge ${SEVERITY_CLASS[r.payload.severity ?? 'NONE'] ?? 'none'}`}>{r.payload.severity ?? 'NONE'}</span></td>
                    <td>
                      {r.publishedBy
                        ? <span title={r.publishedBy.role === 'doctor' ? `doctor at ${r.publishedBy.hospitalId ?? '—'}` : r.publishedBy.role}>{r.publishedBy.username}</span>
                        : <span className="muted">system</span>}
                    </td>
                    <td>{r.version}</td>
                    <td>{r.globalSeq}</td>
                  </tr>
                ))}
                {filteredRules.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>{rules.length === 0 ? 'no rules published yet' : 'no rules match the search/filter'}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel" style={{ border: 0, padding: 0 }}>
          <h2>Provide drug to hospitals</h2>
          <div className="row" style={{ flexDirection: 'column', gap: 8, alignItems: 'stretch' }}>
            <input placeholder="drug / medicine name (e.g. aspirin)" value={provideDrugName} onChange={(e) => setProvideDrugName(e.target.value)} />
            <div className="search-row">
              <input placeholder="filter hospitals…" value={hospitalSearch} onChange={(e) => setHospitalSearch(e.target.value)} style={{ minWidth: 140 }} />
              <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setProvideSelected(new Set(filteredHospitals.map((h) => h.siteId)))}>select filtered</button>
              <button style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setProvideSelected(new Set())}>clear selection</button>
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 8 }}>
              {filteredHospitals.map((h) => (
                <label key={h.siteId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '2px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={provideSelected.has(h.siteId)} onChange={() => toggleProvide(h.siteId)} />
                  <span>{h.name}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{h.siteId}</span>
                </label>
              ))}
              {filteredHospitals.length === 0 && <div className="muted" style={{ fontSize: 12 }}>no hospitals match the filter</div>}
            </div>
            <div className="row"><span className="k">selected hospitals</span><span>{provideSelected.size}</span></div>
            <button className="primary" onClick={provideDrug} disabled={provideBusy}>{provideBusy ? 'Providing…' : `Provide drug to ${provideSelected.size} hospital${provideSelected.size === 1 ? '' : 's'}`}</button>
            {provideError && <div className="err" style={{ fontSize: 13 }}>{provideError}</div>}
            {provideResult && <div className="ok" style={{ fontSize: 13 }}>{provideResult}</div>}
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              Provision a drug only to the hospitals you pick — instead of every hospital. Individual hospitals can also stock drugs from their own page.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [session, setSessionState] = useState<Session | null>(() => loadSession());
  const [sites, setSites] = useState<SiteState[]>([]);
  const [epoch, setEpoch] = useState<{ epochSeq: number; updatedAt: string }>({ epochSeq: 0, updatedAt: '' });
  const [events, setEvents] = useState<LiveEventMsg[]>([]);
  const [lastOrder, setLastOrder] = useState<{ orderId: string; orderEpoch: number; results: AlertResultView[] } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ledgerStatus, setLedgerStatus] = useState<string>('');
  const [chaosSite, setChaosSite] = useState('site-b');
  const [chaosLatency, setChaosLatency] = useState(4000);
  const [viewingHospital, setViewingHospital] = useState<string | null>(null);
  const [viewingLogistics, setViewingLogistics] = useState(false);

  const refresh = async () => {
    if (!session) return;
    try {
      const [sitesRes, wmRes, epochRes] = await Promise.all([
        api(session, setSession, '/api/sites').then((r) => r.json()),
        api(session, setSession, '/api/watermarks').then((r) => r.json()),
        api(session, setSession, '/api/epoch').then((r) => r.json()),
      ]);
      const wmById = new Map(
        (wmRes.watermarks ?? []).map((w: { siteId: string; watermarkSeq: number }) => [w.siteId, w.watermarkSeq]),
      );
      setSites((prev) => {
        const byId = new Map(prev.map((s) => [s.siteId, s]));
        return sitesRes.map((s: Record<string, unknown>) => ({
          siteId: s.siteId as string,
          watermark: wmById.get(s.siteId as string) ?? byId.get(s.siteId as string)?.watermark ?? 0,
          baseLatencyMs: s.baseLatencyMs as number,
          jitterMs: s.jitterMs as number,
          dropRate: s.dropRate as number,
        }));
      });
      setEpoch(epochRes);
    } catch {
      /* services starting up */
    }
  };

  useEffect(() => {
    if (!session) return;
    void refresh();
    // Restore the event feed from the persistent ledger so the log is
    // populated immediately after a page refresh (not just via WebSocket).
    void (async () => {
      try {
        const res = await api(session, setSession, '/api/events/recent?limit=100');
        if (res.ok) {
          const blocks = await res.json();
          setEvents((prev) => {
            const restored = blocks as LiveEventMsg[];
            return [...restored, ...prev].slice(0, 200);
          });
        }
      } catch { /* starting up */ }
    })();
    // JWT via query param — browsers can't set WS headers
    const ws = new WebSocket(`ws://${location.host}/ws/live?token=${encodeURIComponent(session.accessToken)}`);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as LiveEventMsg;
        setEvents((prev) => [msg, ...prev].slice(0, 200));
        if (msg.type === 'WATERMARK') {
          setSites((prev) => prev.map((s) =>
            s.siteId === msg.data.siteId ? { ...s, watermark: msg.data.watermarkSeq as number } : s,
          ));
        }
        if (msg.type === 'EPOCH') {
          setEpoch({ epochSeq: msg.data.epochSeq as number, updatedAt: msg.data.updatedAt as string });
        }
      } catch { /* ignore */ }
    };
    const iv = setInterval(refresh, 3000);
    return () => { clearInterval(iv); ws.close(); };
  }, [session?.accessToken]);

  const canPublish = session?.role === 'admin' || session?.role === 'doctor';
  const canChaos = session?.role === 'admin';
  const canOrder = session?.role === 'admin' || session?.role === 'operator';
  const canAudit = session?.role === 'admin' || session?.role === 'auditor';

  const publishV2 = async () => {
    if (!session) return;
    setPublishing(true);
    try {
      await api(session, setSession, '/api/reference/rules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ruleId: 'drug-interaction-warfarin-aspirin',
          payload: { drugA: 'warfarin', drugB: 'aspirin', severity: 'SEVERE', note: 'V2: major bleeding risk' },
        }),
      });
    } finally { setPublishing(false); }
  };

  const submitOrder = async () => {
    if (!session) return;
    setSubmitting(true);
    try {
      const res = await api(session, setSession, '/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          orderCode: 'RX-WARFARIN-ASPIRIN',
          patientRef: 'patient-042',
          details: { drugs: ['warfarin', 'aspirin'] },
        }),
      });
      const body = await res.json();
      setLastOrder({ orderId: body.orderId, orderEpoch: body.orderEpoch, results: body.results });
    } finally { setSubmitting(false); }
  };

  const injectChaos = async () => {
    if (!session) return;
    await api(session, setSession, `/api/sites/${chaosSite}/network`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseLatencyMs: chaosLatency, jitterMs: 200, dropRate: 0 }),
    });
    void refresh();
  };

  const verifyLedger = async () => {
    if (!session) return;
    const res = await api(session, setSession, '/api/audit/verify').then((r) => r.json());
    setLedgerStatus(res.valid ? `✅ chain valid (${res.blocksChecked} blocks)` : `❌ TAMPERED at block ${res.firstBadIndex}: ${res.reason}`);
  };

  const logout = async () => {
    if (session) {
      await api(session, setSession, '/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    }
    setSession(null);
    setSites([]);
    setEvents([]);
    setLastOrder(null);
  };

  /** Session setter that keeps localStorage in sync (page refresh stays logged in). */
  const setSession = (s: Session | null) => {
    setSessionState(s);
    saveSession(s);
  };

  const allMatch = lastOrder && lastOrder.results.length > 1 &&
    lastOrder.results.every((r) => r.fires === lastOrder.results[0].fires && r.severity === lastOrder.results[0].severity && r.epochUsed === lastOrder.results[0].epochUsed);

  // Boot validation: a hydrated session may hold an expired/revoked refresh
  // token (e.g. server reset). Probe once; if auth ultimately fails, drop
  // back to the login screen instead of showing a broken dashboard.
  const bootedRef = React.useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    if (!session) return;
    bootedRef.current = true;
    void (async () => {
      const res = await api(session, setSession, '/api/epoch');
      if (res.status === 401) setSession(null);
    })();
  }, [session?.accessToken]);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  if (viewingLogistics) {
    return (
      <LogisticsPage
        onBack={() => setViewingLogistics(false)}
        themeToggle={<ThemeToggle />}
      />
    );
  }

  if (viewingHospital) {
    return (
      <HospitalPage
        session={session}
        setSession={setSession}
        siteId={viewingHospital}
        onBack={() => setViewingHospital(null)}
      />
    );
  }

  if (session.role === 'doctor') {
    return <DoctorPage session={session} setSession={setSession} onLogout={logout} onOpenHospital={(siteId) => setViewingHospital(siteId)} onOpenLogistics={() => setViewingLogistics(true)} />;
  }

  if (session.role === 'patient') {
    return <PatientPortal session={session} setSession={setSession} onLogout={logout} />;
  }

  if (session.role === 'nurse') {
    return <NursePage session={session} setSession={setSession} onLogout={logout} />;
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Distributed Clinical Reference-Data Consistency</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => setViewingLogistics(true)} title="Real-time medicine shipment tracking" style={{ padding: '4px 10px' }}>🚚 Logistics</button>
          <ThemeToggle />
          <span>{session.username} ({session.role}) ·</span>
          <button onClick={logout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">
        Identical orders evaluated at multiple sites always see the same reference snapshot — even while propagation is mid-flight.
      </div>

      <ManagementHub session={session} setSession={setSession}>
        {(active) => (
          <>
            {active === 'patients' && <PatientsPanel session={session} setSession={setSession} />}
            {active === 'nurses' && <NursesPanel session={session} setSession={setSession} />}
            {active === 'hospitals' && (
              <>
                <AdminSection session={session} setSession={setSession} onRefresh={() => void refresh()} onOpenHospital={(siteId) => setViewingHospital(siteId)} />
              </>
            )}
          </>
        )}
      </ManagementHub>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        <div className="panel">
          <h2>Global Active Epoch</h2>
          <div className="metric">{epoch.epochSeq} <small>min of all site watermarks — the only version any site may evaluate against</small></div>
        </div>
        <div className="panel">
          <h2>Consistency Check</h2>
          <div className="metric" style={{ color: allMatch === false ? 'var(--red)' : 'var(--green)' }}>
            {lastOrder ? (allMatch ? 'CONSISTENT' : 'MISMATCH') : '—'}
          </div>
          <small style={{ color: 'var(--muted)' }}>{lastOrder ? `order ${lastOrder.orderId} @ epoch ${lastOrder.orderEpoch}` : 'submit an order to compare sites'}</small>
        </div>
        <div className="panel">
          <h2>Actions</h2>
          <div className="controls">
            <button className="primary" onClick={publishV2} disabled={publishing || !canPublish} title={canPublish ? undefined : 'requires admin role'}>Publish V2 (severe interaction)</button>
            <button onClick={submitOrder} disabled={submitting || !canOrder} title={canOrder ? undefined : 'requires operator+ role'}>Submit identical order → all sites</button>
          </div>
          <div className="controls">
            <select value={chaosSite} onChange={(e) => setChaosSite(e.target.value)}>
              {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId}</option>)}
            </select>
            <input type="number" value={chaosLatency} onChange={(e) => setChaosLatency(Number(e.target.value))} style={{ width: 90 }} />
            <button onClick={injectChaos} disabled={!canChaos} title={canChaos ? undefined : 'requires admin role'}>Inject latency chaos</button>
          </div>
        </div>
      </div>

      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        {sites.map((s) => {
          const lagging = s.watermark < epoch.epochSeq;
          const ahead = s.watermark > epoch.epochSeq;
          return (
            <div key={s.siteId} className={`panel site-card ${lagging ? 'lagging' : ahead ? 'ahead' : ''}`}>
              <h2>{s.siteId}</h2>
              <div className="row"><span className="k">watermark (cached)</span><span>{s.watermark}</span></div>
              <div className="row"><span className="k">evaluating at epoch</span><span>{epoch.epochSeq}</span></div>
              <div className="row"><span className="k">latency / jitter / drop</span><span>{s.baseLatencyMs}ms / {s.jitterMs}ms / {(s.dropRate * 100).toFixed(0)}%</span></div>
              {ahead && <div className="row"><span className="k">state</span><span className="ok">cached ahead — gated, not yet active</span></div>}
              {lagging && <div className="row"><span className="k">state</span><span className="warn">propagation lagging — epoch held</span></div>}
            </div>
          );
        })}
      </div>

      {lastOrder && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h2>Side-by-side alert comparison — {lastOrder.orderId}</h2>
          <div className="comparison">
            {lastOrder.results.map((r) => (
              <div key={r.siteId} className={`result-card ${allMatch ? 'match' : 'mismatch'}`}>
                <div className="row"><span className="k">site</span><span>{r.siteId}</span></div>
                <div className="row"><span className="k">fires</span><span>{r.fires ? 'YES' : 'no'}</span></div>
                <div className="row"><span className="k">severity</span><span><span className={`badge ${SEVERITY_CLASS[r.severity] ?? 'none'}`}>{r.severity}</span>{r.provisional && <span className="badge provisional">PROVISIONAL</span>}</span></div>
                <div className="row"><span className="k">epochUsed</span><span>{r.epochUsed}</span></div>
                <div className="row"><span className="k">watermarkAtEval</span><span>{r.watermarkAtEval}</span></div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid cols-2">
        <div className="panel">
          <h2>Live event log</h2>
          <div className="event-log">
            {events.map((e, i) => (
              <div key={i}>
                <span className="warn">[{fmtIST(e.ts)}]</span>{' '}
                <span className="ok">{e.type}</span>{' '}
                {typeof e.data.eventType === 'string' ? <span className="badge none">{e.data.eventType}</span> : null}{' '}
                {e.data.username ? <span>by <b>{String(e.data.username)}</b>{typeof e.data.role === 'string' ? ` (${e.data.role})` : ''} </span> : null}
                {e.data.ip ? <span className="muted">from {String(e.data.ip)}</span> : null}{' '}
                {e.data.mac ? <span className="muted">[{String(e.data.mac)}]</span> : null}{' '}
                {(() => { const { ip, mac, username, role, eventType, blockIndex, ...rest } = e.data as Record<string, unknown>; void ip; void mac; void username; void role; void eventType; void blockIndex; return Object.keys(rest).length > 0 ? <span className="muted">{JSON.stringify(rest)}</span> : null; })()}
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <h2>Audit ledger</h2>
          <div className="controls">
            <button onClick={verifyLedger} disabled={!canAudit} title={canAudit ? undefined : 'requires auditor+ role'}>Run integrity check</button>
          </div>
          <div style={{ fontSize: 13 }}>{ledgerStatus || 'click to walk the hash chain'}</div>
        </div>
      </div>

      <div className="footer-note">
        Epoch-gated convergence: sites cache new data as fast as it arrives, but evaluate only against the global active epoch (min watermark), stamped once per order at submission. Conservative fallback escalates rather than suppresses under residual uncertainty.
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
