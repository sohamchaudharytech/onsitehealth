#!/usr/bin/env node
/**
 * Non-destructive demo seed. The service already seeds its demo users,
 * hospitals, and patient on startup; this adds the V1 interaction rule only
 * when it is absent, so repeated runs are safe.
 */

const centralUrl = process.env.CENTRAL_URL ?? 'http://localhost:4001';

async function request(path, init = {}) {
  const response = await fetch(`${centralUrl}${path}`, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${path} failed (${response.status}): ${body.error ?? response.statusText}`);
  }
  return body;
}

const auth = await request('/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});

const headers = {
  'content-type': 'application/json',
  authorization: `Bearer ${auth.accessToken}`,
};

const rules = await request('/api/reference/rules', { headers });
if (rules.some((rule) => rule.ruleId === 'WARFARIN_ASPIRIN')) {
  console.log('Seed already present: WARFARIN_ASPIRIN rule exists.');
} else {
  const rule = await request('/api/reference/rules', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ruleId: 'WARFARIN_ASPIRIN',
      payload: {
        drugA: 'warfarin',
        drugB: 'aspirin',
        severity: 'NONE',
        note: 'V1 baseline — no interaction until V2 is published.',
      },
    }),
  });
  console.log(`Seeded WARFARIN_ASPIRIN V${rule.version} at globalSeq ${rule.globalSeq}.`);
}
