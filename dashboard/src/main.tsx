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

const SEVERITY_CLASS: Record<string, string> = {
  NONE: 'none',
  LOW: 'low',
  MODERATE: 'moderate',
  SEVERE: 'severe',
  CRITICAL: 'critical',
};

function App() {
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
    try {
      const [sitesRes, wmRes, epochRes] = await Promise.all([
        fetch('/api/sites').then((r) => r.json()),
        fetch('/api/watermarks').then((r) => r.json()),
        fetch('/api/epoch').then((r) => r.json()),
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
    void refresh();
    const ws = new WebSocket(`ws://${location.host}/ws/live`);
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
  }, []);

  const publishV2 = async () => {
    setPublishing(true);
    try {
      await fetch('/api/reference/rules', {
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
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
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
    await fetch(`/api/sites/${chaosSite}/network`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseLatencyMs: chaosLatency, jitterMs: 200, dropRate: 0 }),
    });
    void refresh();
  };

  const verifyLedger = async () => {
    const res = await fetch('/api/audit/verify').then((r) => r.json());
    setLedgerStatus(res.valid ? `✅ chain valid (${res.blocksChecked} blocks)` : `❌ TAMPERED at block ${res.firstBadIndex}: ${res.reason}`);
  };

  const allMatch = lastOrder && lastOrder.results.length > 1 &&
    lastOrder.results.every((r) => r.fires === lastOrder.results[0].fires && r.severity === lastOrder.results[0].severity && r.epochUsed === lastOrder.results[0].epochUsed);

  return (
    <div className="app">
      <h1>Distributed Clinical Reference-Data Consistency</h1>
      <div className="subtitle">
        Identical orders evaluated at multiple sites always see the same reference snapshot — even while propagation is mid-flight.
      </div>

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
            <button className="primary" onClick={publishV2} disabled={publishing}>Publish V2 (severe interaction)</button>
            <button onClick={submitOrder} disabled={submitting}>Submit identical order → all sites</button>
          </div>
          <div className="controls">
            <select value={chaosSite} onChange={(e) => setChaosSite(e.target.value)}>
              {sites.map((s) => <option key={s.siteId} value={s.siteId}>{s.siteId}</option>)}
            </select>
            <input type="number" value={chaosLatency} onChange={(e) => setChaosLatency(Number(e.target.value))} style={{ width: 90 }} />
            <button onClick={injectChaos}>Inject latency chaos</button>
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
            <button onClick={verifyLedger}>Run integrity check</button>
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
