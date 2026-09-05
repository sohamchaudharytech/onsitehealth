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

const SEVERITY_CLASS: Record<string, string> = {
  NONE: 'none',
  LOW: 'low',
  MODERATE: 'moderate',
  SEVERE: 'severe',
  CRITICAL: 'critical',
};

/**
 * Authenticated fetch with automatic refresh-token rotation on 401.
 * Single-flight: concurrent 401s share ONE in-flight refresh call — otherwise
 * parallel requests race, each rotates the refresh token, and the reuse of an
 * already-rotated token trips theft detection (family revocation).
 */
let inflightRefresh: Promise<Session | null> | null = null;

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

async function api(session: Session, setSession: (s: Session) => void, url: string, init: RequestInit = {}): Promise<Response> {
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
          Demo accounts — admin/admin123 · operator/operator123 · auditor/auditor123 · viewer/viewer123 · doctor/doctor123
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
}

/**
 * Doctor portal — focused clinician view for publishing/updating drug-interaction
 * reference rules. One publish fans out to every hospital site automatically;
 * the global epoch advances only after ALL sites confirm receipt, so no
 * hospital ever evaluates a partial update.
 */
function DoctorPage({ session, setSession, onLogout }: { session: Session; setSession: (s: Session) => void; onLogout: () => void }) {
  const [sites, setSites] = useState<SiteState[]>([]);
  const [epoch, setEpoch] = useState<{ epochSeq: number; updatedAt: string }>({ epochSeq: 0, updatedAt: '' });
  const [rules, setRules] = useState<RuleVersionView[]>([]);
  const [drugA, setDrugA] = useState('');
  const [drugB, setDrugB] = useState('');
  const [severity, setSeverity] = useState('SEVERE');
  const [note, setNote] = useState('');
  const [publishing, setPublishing] = useState(false);
  const [formError, setFormError] = useState('');
  const [lastPublish, setLastPublish] = useState<{ ruleId: string; version: number; globalSeq: number } | null>(null);

  const refresh = async () => {
    try {
      const [sitesRes, wmRes, epochRes, rulesRes] = await Promise.all([
        api(session, setSession, '/api/sites').then((r) => r.json()),
        api(session, setSession, '/api/watermarks').then((r) => r.json()),
        api(session, setSession, '/api/epoch').then((r) => r.json()),
        api(session, setSession, '/api/reference/rules').then((r) => r.json()),
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

  // latest version of each rule (rules arrive sorted by globalSeq)
  const latestByRule = new Map<string, RuleVersionView>();
  for (const r of rules) latestByRule.set(r.ruleId, r);
  const currentRules = [...latestByRule.values()].sort((x, y) => y.globalSeq - x.globalSeq);

  const latestSeq = rules.length ? Math.max(...rules.map((r) => r.globalSeq)) : 0;
  const targetSeq = lastPublish?.globalSeq ?? latestSeq;
  const allReceived = sites.length > 0 && targetSeq > 0 && sites.every((s) => s.watermark >= targetSeq);
  const epochActive = targetSeq > 0 && epoch.epochSeq >= targetSeq;

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Doctor Portal — Drug Reference Updates</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {session.username} ({session.role}) · <button onClick={onLogout} style={{ padding: '4px 10px' }}>Sign out</button>
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
          <h2>Current interaction rules</h2>
          <table>
            <thead>
              <tr><th>interaction</th><th>severity</th><th>v</th><th>seq</th><th></th></tr>
            </thead>
            <tbody>
              {currentRules.map((r) => (
                <tr key={r.ruleId}>
                  <td>{r.payload.drugA} + {r.payload.drugB}</td>
                  <td><span className={`badge ${SEVERITY_CLASS[r.payload.severity ?? 'NONE'] ?? 'none'}`}>{r.payload.severity ?? 'NONE'}</span></td>
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
              {currentRules.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--muted)' }}>no rules published yet</td></tr>}
            </tbody>
          </table>
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

      <div className="footer-note">
        Every update is versioned and hash-chained into the audit ledger. Hospital sites cache new versions as they arrive but evaluate only against the global active epoch (min watermark across all sites) — guaranteeing identical alerts at every hospital.
      </div>
    </div>
  );
}

/**
 * Admin management section — hospitals & doctors CRUD plus simulated
 * hospital generation for scalability testing. Rendered for admin only
 * (backed by the hospitals:manage / users:manage permissions).
 */
function AdminSection({ session, setSession, onRefresh }: { session: Session; setSession: (s: Session) => void; onRefresh: () => void }) {
  const [hospitals, setHospitals] = useState<HospitalView[]>([]);
  const [doctors, setDoctors] = useState<DoctorView[]>([]);
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

  const isAdmin = session.role === 'admin';

  const refreshAdmin = async () => {
    if (!isAdmin) return;
    try {
      const [hRes, dRes] = await Promise.all([
        api(session, setSession, '/api/hospitals').then((r) => r.json()),
        api(session, setSession, '/api/doctors').then((r) => r.json()),
      ]);
      setHospitals(hRes);
      setDoctors(dRes);
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

  if (!isAdmin) return null;

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
          <h2>Hospitals ({hospitals.length})</h2>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>name</th><th>site</th><th>region</th><th>doctors</th><th>type</th><th></th></tr>
              </thead>
              <tbody>
                {hospitals.map((h) => (
                  <tr key={h.siteId}>
                    <td>{h.name}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{h.siteId}</td>
                    <td>{h.region}</td>
                    <td>{h.doctorCount}</td>
                    <td>{h.simulated ? <span className="badge low">SIM</span> : <span className="badge none">REAL</span>}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeHospital(h.siteId)}>remove</button></td>
                  </tr>
                ))}
                {hospitals.length === 0 && <tr><td colSpan={6} style={{ color: 'var(--muted)' }}>no hospitals</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h2>Doctors ({doctors.length})
            <button style={{ padding: '2px 8px', fontSize: 11, marginLeft: 8, textTransform: 'none' }} onClick={generateDoctors} disabled={simBusy || hospitals.length === 0}>generate test doctors</button>
          </h2>
          <div style={{ maxHeight: 280, overflowY: 'auto' }}>
            <table>
              <thead>
                <tr><th>name</th><th>username</th><th>hospital</th><th></th></tr>
              </thead>
              <tbody>
                {doctors.map((d) => (
                  <tr key={d.userId}>
                    <td>{d.fullName ?? d.username}</td>
                    <td style={{ fontFamily: 'ui-monospace, monospace' }}>{d.username}</td>
                    <td>{d.hospitalName ?? d.hospitalId ?? '—'}</td>
                    <td><button style={{ padding: '2px 8px', fontSize: 11 }} onClick={() => void removeDoctor(d.userId)}>remove</button></td>
                  </tr>
                ))}
                {doctors.length === 0 && <tr><td colSpan={4} style={{ color: 'var(--muted)' }}>no doctors</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sites, setSites] = useState<SiteState[]>([]);
  const [epoch, setEpoch] = useState<{ epochSeq: number; updatedAt: string }>({ epochSeq: 0, updatedAt: '' });
  const [events, setEvents] = useState<LiveEventMsg[]>([]);
  const [lastOrder, setLastOrder] = useState<{ orderId: string; orderEpoch: number; results: AlertResultView[] } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ledgerStatus, setLedgerStatus] = useState<string>('');
  const [chaosSite, setChaosSite] = useState('site-b');
  const [chaosLatency, setChaosLatency] = useState(4000);

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
  const canAdminManage = session?.role === 'admin';

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

  const allMatch = lastOrder && lastOrder.results.length > 1 &&
    lastOrder.results.every((r) => r.fires === lastOrder.results[0].fires && r.severity === lastOrder.results[0].severity && r.epochUsed === lastOrder.results[0].epochUsed);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  if (session.role === 'doctor') {
    return <DoctorPage session={session} setSession={setSession} onLogout={logout} />;
  }

  return (
    <div className="app">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Distributed Clinical Reference-Data Consistency</h1>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          {session.username} ({session.role}) · <button onClick={logout} style={{ padding: '4px 10px' }}>Sign out</button>
        </div>
      </div>
      <div className="subtitle">
        Identical orders evaluated at multiple sites always see the same reference snapshot — even while propagation is mid-flight.
      </div>

      {canAdminManage && <AdminSection session={session} setSession={setSession} onRefresh={() => void refresh()} />}

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
                <span className="warn">[{e.ts.slice(11, 23)}]</span>{' '}
                <span className="ok">{e.type}</span>{' '}
                {JSON.stringify(e.data)}
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
