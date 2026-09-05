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
  publishedBy?: PublisherView;
}

/**
 * Hospital page — the formulary view for a single hospital. Both admin and
 * doctor see which drugs/medicines the hospital stocks, who provisioned each,
 * and can add drugs individually here or remove them. Opening a hospital is
 * available from the admin section and the doctor portal.
 */
function HospitalPage({ session, setSession, siteId, onBack }: {
  session: Session;
  setSession: (s: Session) => void;
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
      <div className="back-link"><button onClick={onBack}>← back to dashboard</button></div>
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
                    <td className="muted">{d.addedAt.slice(0, 19).replace('T', ' ')}</td>
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
function DoctorPage({ session, setSession, onLogout, onOpenHospital }: { session: Session; setSession: (s: Session) => void; onLogout: () => void; onOpenHospital: (siteId: string) => void }) {
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

      <div className="grid cols-2" style={{ marginBottom: 16 }}>
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
 * hospital generation for scalability testing, drug distribution across
 * hospitals, and a full rules view with attribution (who added which drug).
 * Rendered for admin only (backed by hospitals:manage / users:manage).
 */
function AdminSection({ session, setSession, onRefresh, onOpenHospital }: { session: Session; setSession: (s: Session) => void; onRefresh: () => void; onOpenHospital: (siteId: string) => void }) {
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
  const [viewingHospital, setViewingHospital] = useState<string | null>(null);

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
    return <DoctorPage session={session} setSession={setSession} onLogout={logout} onOpenHospital={(siteId) => setViewingHospital(siteId)} />;
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

      {canAdminManage && <AdminSection session={session} setSession={setSession} onRefresh={() => void refresh()} onOpenHospital={(siteId) => setViewingHospital(siteId)} />}

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
