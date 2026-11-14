import { limits } from './rules.ts';
import { normalizeDomain, sameCompany } from './normalize.ts';

export type OrgFacts = {
  name: string;
  domain?: string | null;
  employees?: number | null;
  is_listed?: number | boolean;
  is_unicorn?: number | boolean;
  is_mnc?: number | boolean;
  is_brand?: number | boolean;
};

export type Tier = { tier: 'small' | 'big' | 'unknown'; reasons: string[] };

// Big if ANY rule fires. Unknown headcount with no other signal stays unknown, which the gate treats as big.
export function classifyTier(org: OrgFacts, dreamList: string[] = []): Tier {
  const rule = limits().big_company;
  const reasons: string[] = [];
  const name = org.name.trim().toLowerCase();
  const domain = normalizeDomain(org.domain ?? null);
  const onDream = dreamList.some((d) => {
    const v = d.trim().toLowerCase();
    return v === name || sameCompany(v, name) || (domain !== null && normalizeDomain(v) === domain);
  });
  if (rule.dream_list && onDream) reasons.push('on the dream list');
  if (org.employees != null && org.employees >= rule.employees_at_least) reasons.push(`${org.employees} employees (>= ${rule.employees_at_least})`);
  if (rule.listed && org.is_listed) reasons.push('listed company');
  if (rule.unicorn && org.is_unicorn) reasons.push('unicorn');
  if (rule.mnc && org.is_mnc) reasons.push('MNC');
  if (rule.brand && org.is_brand) reasons.push('well-known brand');
  if (reasons.length) return { tier: 'big', reasons };
  if (org.employees == null) return { tier: 'unknown', reasons: ['headcount unknown'] };
  return { tier: 'small', reasons: [`${org.employees} employees, no big-company signal`] };
}
