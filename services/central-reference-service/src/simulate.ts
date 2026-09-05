import express from 'express';
import { internalKeyGuard, newOpaqueToken, type AlertResult } from '@hc/shared';

/**
 * In-process simulated hospital agents for scalability testing.
 *
 * A "simulated hospital" behaves exactly like a real site-agent over the
 * wire: an HTTP server with /internal/push, /internal/evaluate, and
 * watermark ACKs to the coordinator. Unlike real agents (separate OS
 * processes), hundreds can run inside the central service process — so
 * the admin can dial the fleet from 3 hospitals to 500+ and watch
 * fan-out, epoch gating, and consistency hold (or break) at scale.
 *
 * The central service is the single process allowed to host these; a
 * restart forgets them (site registrations persist via the store only if
 * re-seeded — acceptable for a scale-test tool).
 */

export interface SimSite {
  siteId: string;
  server: ReturnType<typeof express>;
  handle: import('http').Server;
  port: number;
}

export function startSimSite(
  siteId: string,
  port: number,
  deps: {
    push: (ruleVersion: Record<string, unknown>) => { isNew: boolean; watermark: number };
    evaluate: (order: Record<string, unknown>, orderEpoch: number) => AlertResult;
  },
): Promise<SimSite> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/internal', internalKeyGuard(process.env.INTERNAL_KEY ?? 'dev-internal-key'));
  app.post('/internal/push', (req, res) => {
    const { ruleVersion } = req.body ?? {};
    if (!ruleVersion?.ruleId || typeof ruleVersion.globalSeq !== 'number') {
      res.status(400).json({ error: 'ruleVersion required' });
      return;
    }
    const { isNew, watermark } = deps.push(ruleVersion);
    if (isNew) {
      void fetch(`${process.env.COORDINATOR_URL ?? 'http://localhost:4002'}/internal/ack`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': process.env.INTERNAL_KEY ?? 'dev-internal-key' },
        body: JSON.stringify({ siteId, watermarkSeq: watermark }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
    }
    res.json({ ok: true, watermark });
  });
  app.post('/internal/evaluate', (req, res) => {
    const { order, orderEpoch } = req.body ?? {};
    if (!order?.orderCode) {
      res.status(400).json({ error: 'order.orderCode required' });
      return;
    }
    res.json(deps.evaluate(order as Record<string, unknown>, Number(orderEpoch ?? 0)));
  });
  return new Promise((resolve) => {
    const handle = app.listen(port, () => {
      resolve({ siteId, server: app, handle, port });
    });
  });
}

// ── Name generators — no faker dependency, deterministic-ish variety ────────

const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Northeast', 'Southwest', 'Southeast', 'Northwest', 'Midwest'];
const HOSPITAL_TYPES = ['General', 'Regional', 'University', 'Community', 'Memorial', 'St. Mary', 'Providence', 'Mercy', 'Sacred Heart', 'Unity'];

export function generateHospitalName(index: number): string {
  const type = HOSPITAL_TYPES[index % HOSPITAL_TYPES.length];
  const cycle = Math.floor(index / HOSPITAL_TYPES.length) + 1;
  return cycle === 1 ? `${type} Hospital` : `${type} Hospital ${cycle}`;
}

export function generateRegion(index: number): string {
  return `${REGIONS[index % REGIONS.length]} Region`;
}

const FIRST_NAMES = ['Althea', 'Priya', 'Marcus', 'Elena', 'Kofi', 'Mei', 'Sofia', 'Dmitri', 'Aisha', 'Liam', 'Nadia', 'Takeshi', 'Ingrid', 'Rosa', 'Omar', 'Freya', 'Jorge', 'Anika', 'Ravi', 'Sanne', 'Tunde', 'Greta', 'Mateo', 'Yuki', 'Zara'];
const LAST_NAMES = ['Okafor', 'Sharma', 'Lindqvist', 'Rossi', 'Mensah', 'Chen', 'Garcia', 'Volkov', 'Rahman', 'Murphy', 'Petrov', 'Tanaka', 'Berg', 'Silva', 'Haddad', 'Nilsen', 'Vargas', 'Kapoor', 'Iyer', 'de Vries', 'Adeyemi', 'Weber', 'Alvarez', 'Sato', 'Khan'];
const DOCTOR_TITLES = ['Dr.', 'Dr.', 'Dr.', 'Prof.'];

/** Index 0 = first generated doctor; name parts cycle deterministically. */
export function generateDoctorName(index: number): { fullName: string; first: string; last: string } {
  const first = FIRST_NAMES[index % FIRST_NAMES.length];
  const last = LAST_NAMES[(index * 7) % LAST_NAMES.length];
  const title = DOCTOR_TITLES[index % DOCTOR_TITLES.length];
  return { fullName: `${title} ${first} ${last}`, first, last };
}

/** Human-memorable demo password for generated doctors (scalability testing, not production). */
export function generateDoctorPassword(): string {
  return `doc-${newOpaqueToken().slice(0, 10)}`;
}

/** Port range for simulated hospital agents (4201+). */
export function simPortFor(portOffset: number): number {
  return 4201 + portOffset;
}
