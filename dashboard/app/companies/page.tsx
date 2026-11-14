import Link from "next/link";
import { Badge, Empty, Filters, PageHead } from "@/components/ui";
import { query } from "@/lib/db";
import { day } from "@/lib/format";

type Org = { id: number; name: string; domain: string | null; website: string | null; tier: string; sector: string | null; city: string | null; employees: number | null; people: number; opps: number; msgs: number; updated_at: string };

export default async function Companies({ searchParams }: { searchParams: Promise<{ tier?: string; q?: string }> }) {
  const { tier, q } = await searchParams;
  const where: string[] = [];
  const args: string[] = [];
  if (tier) { where.push("o.tier = ?"); args.push(tier); }
  if (q) { where.push("(o.name LIKE ? OR o.domain LIKE ? OR o.sector LIKE ? OR o.city LIKE ?)"); args.push(...Array(4).fill(`%${q}%`)); }
  const orgs = await query<Org>(
    `SELECT o.*, (SELECT count(*) FROM people p WHERE p.organization_id = o.id) AS people,
       (SELECT count(*) FROM opportunities x WHERE x.organization_id = o.id) AS opps,
       (SELECT count(*) FROM messages m WHERE m.organization_id = o.id) AS msgs
     FROM organizations o ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY o.updated_at DESC LIMIT 500`,
    ...args,
  );
  return (
    <>
      <PageHead title="Companies">Every company and business the agents have looked at, with the people they found there. Big companies always wait for your approval.</PageHead>
      <form style={{ marginBottom: 12 }}><input className="search" name="q" defaultValue={q} placeholder="Search name, website, sector, city" aria-label="Search companies" />{tier ? <input type="hidden" name="tier" value={tier} /> : null}</form>
      <Filters base="/companies" param="tier" current={tier} options={[{ value: "", label: "All" }, { value: "small", label: "Small" }, { value: "big", label: "Big" }, { value: "unknown", label: "Size unknown" }]} />
      <div className="panel table-wrap">
        {orgs.length ? (
          <table className="t cards">
            <thead><tr><th>Company</th><th>Size</th><th>Sector</th><th>City</th><th className="num">People</th><th className="num">Opportunities</th><th className="num">Messages</th><th>Updated</th></tr></thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id}>
                  <td data-label="Company"><Link href={`/companies/${o.id}`} className="strong">{o.name}</Link><div className="small">{o.domain ?? ""}</div></td>
                  <td data-label="Size"><Badge value={o.tier} kind={o.tier === "big" ? "meh" : o.tier === "small" ? "good" : "plain"} />{o.employees ? <div className="small">{o.employees} staff</div> : null}</td>
                  <td data-label="Sector">{o.sector}</td><td data-label="City">{o.city}</td>
                  <td data-label="People" className="num">{o.people}</td><td data-label="Openings" className="num">{o.opps}</td><td data-label="Messages" className="num">{o.msgs}</td><td data-label="Updated" className="small">{day(o.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <Empty title={q || tier ? "No companies match" : "No companies yet"}>{q || tier ? "Try a different search or filter." : "The scout and researcher add them as they work."}</Empty>}
      </div>
    </>
  );
}
