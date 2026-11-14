import { limits } from './rules.ts';

// Agents judge each dimension (1-5) and give a reason; the engine combines them the same way every time,
// so the dashboard can show exactly why something scored what it did.
export const DEFAULT_WEIGHTS: Record<string, Record<string, number>> = {
  job: { role_fit: 0.3, eligibility: 0.2, goal_alignment: 0.2, company_quality: 0.1, recency: 0.1, reachability: 0.1 },
  freelance: { need_signal: 0.3, budget_signal: 0.2, offer_fit: 0.2, reachability: 0.15, recency: 0.15 },
  lead: { match: 0.5, completeness: 0.3, recency: 0.2 },
};

export type Dimension = { score: number; reason: string };
export type FitResult = { score: number; eligible: boolean; reasons: string[]; missing: string[] };

export function combineFit(track: string, dims: Record<string, Dimension>, weights = DEFAULT_WEIGHTS[track]): FitResult {
  if (!weights) throw new Error(`no weights for track ${track}`);
  let total = 0;
  let used = 0;
  const reasons: string[] = [];
  const missing: string[] = [];
  for (const [dim, w] of Object.entries(weights)) {
    const d = dims[dim];
    if (!d) { missing.push(dim); continue; }
    const s = Math.min(5, Math.max(1, d.score));
    total += s * w;
    used += w;
    reasons.push(`${dim} ${s}/5 x${w}: ${d.reason}`);
  }
  // Missing dimensions are not guessed: the score is scaled over what was judged, and listed as unknowns.
  const score = used ? Math.round((total / used) * 100) / 100 : 0;
  const hardBlock = dims.eligibility && dims.eligibility.score <= 1;
  if (hardBlock) reasons.push('eligibility 1/5 blocks this regardless of the total');
  return { score, eligible: !hardBlock && used >= 0.6 && score >= limits().min_fit, reasons, missing };
}
