// A/B tests the engine runs fairly: variants are handed out in turn, and a result is only called
// once each variant has enough first messages and the difference is unlikely to be chance.
import type { DatabaseSync } from 'node:sqlite';
import type { Row } from './db.ts';

type Exp = { id: number; track: string; dimension: string; variants: string[]; min_n: number; status: string };

function load(db: DatabaseSync, id: number): Exp {
  const r = db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new Error(`experiment ${id} not found`);
  return { id, track: String(r.track), dimension: String(r.dimension), variants: JSON.parse(String(r.variants)) as string[], min_n: Number(r.min_n), status: String(r.status) };
}

// Sends (and queued drafts) so far per variant, counted from the variant tags on first messages.
export function counts(db: DatabaseSync, e: Exp): Record<string, { n: number; replied: number; positive: number; queued: number }> {
  const out: Record<string, { n: number; replied: number; positive: number; queued: number }> = {};
  for (const v of e.variants) out[v] = { n: 0, replied: 0, positive: 0, queued: 0 };
  const rows = db.prepare(`SELECT m.status, json_extract(m.variant, '$.' || ?) AS v,
      (SELECT reply_class FROM messages r WHERE r.direction = 'in' AND r.thread_key = m.thread_key AND ifnull(r.reply_class,'') NOT IN ('auto','ooo') ORDER BY r.id LIMIT 1) AS rc
    FROM messages m WHERE m.direction = 'out' AND m.sequence_step = 0 AND m.track = ? AND m.variant IS NOT NULL AND datetime(m.created_at) >= datetime((SELECT started_at FROM experiments WHERE id = ?))`).all(e.dimension, e.track, e.id) as Row[];
  for (const r of rows) {
    const c = out[String(r.v)];
    if (!c) continue;
    if (['sent', 'bounced'].includes(String(r.status))) { c.n++; if (r.rc) c.replied++; if (['positive', 'interview', 'referral'].includes(String(r.rc))) c.positive++; }
    else if (['drafted', 'queued', 'pending_review', 'approved'].includes(String(r.status))) c.queued++;
  }
  return out;
}

// The variant with the fewest sends plus queued drafts goes next, so the arms stay balanced.
export function pickVariant(db: DatabaseSync, track: string, dimension: string): { experiment_id: number | null; variant: string | null } {
  const r = db.prepare(`SELECT id FROM experiments WHERE track = ? AND dimension = ? AND status = 'running' ORDER BY id DESC LIMIT 1`).get(track, dimension) as Row | undefined;
  if (!r) return { experiment_id: null, variant: null };
  const e = load(db, Number(r.id));
  const c = counts(db, e);
  const variant = [...e.variants].sort((a, b) => (c[a].n + c[a].queued) - (c[b].n + c[b].queued))[0];
  return { experiment_id: e.id, variant };
}

// Two-proportion z-test on reply rate (positive replies when there are enough of them).
export function compare(a: { n: number; k: number }, b: { n: number; k: number }): { z: number; p: number } {
  const p1 = a.k / a.n, p2 = b.k / b.n;
  const pool = (a.k + b.k) / (a.n + b.n);
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n));
  if (!se) return { z: 0, p: 1 };
  const z = (p1 - p2) / se;
  // Normal tail via the complementary error function (Abramowitz-Stegun 7.1.26).
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erfc = t * Math.exp(-x * x) * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return { z, p: erfc };
}

export function checkExperiment(db: DatabaseSync, id: number, conclude = false): Row {
  const e = load(db, id);
  const c = counts(db, e);
  const ready = e.variants.every((v) => c[v].n >= e.min_n);
  const ranked = [...e.variants].sort((a, b) => c[b].replied / Math.max(1, c[b].n) - c[a].replied / Math.max(1, c[a].n));
  const [best, second] = ranked;
  const test = second ? compare({ n: c[best].n, k: c[best].replied }, { n: c[second].n, k: c[second].replied }) : { z: 0, p: 1 };
  const verdict = !ready ? 'not enough data yet' : test.p < 0.05 ? `${best} wins` : 'no real difference yet';
  const result = { counts: c, leader: best, p_value: Math.round(test.p * 1000) / 1000, verdict, ready };
  if (conclude && ready) {
    db.prepare(`UPDATE experiments SET status = 'concluded', result = ?, ended_at = datetime('now') WHERE id = ?`).run(JSON.stringify(result), id);
  }
  return result;
}
