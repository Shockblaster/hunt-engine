import { Badge, Empty, ExtLink, Filters, PageHead, Section } from "@/components/ui";
import { query } from "@/lib/db";
import { day } from "@/lib/format";

type Lead = {
  id: number; name: string; role: string | null; business: string | null; phone_e164: string | null; phone_type: string | null; email: string | null; email_status: string;
  city: string | null; locality: string | null; website: string | null; rating: number | null; reviews: number | null; confidence: number | null; source_url: string; updated_at: string; opt_out: number; checks: string | null;
};

function confidenceBadge(c: number | null) {
  if (c == null) return <Badge value="not checked yet" kind="plain" />;
  const pct = Math.round(c * 100);
  return <Badge value={`${pct}% sure`} kind={c >= 0.7 ? "good" : c >= 0.4 ? "meh" : "bad"} />;
}

export default async function Leads({ searchParams }: { searchParams: Promise<{ campaign?: string; city?: string }> }) {
  const { campaign, city } = await searchParams;
  const campaigns = await query<{ campaign: string; n: number }>(`SELECT campaign, count(*) AS n FROM people WHERE campaign IS NOT NULL GROUP BY campaign ORDER BY max(updated_at) DESC`);
  const pick = campaign ?? campaigns[0]?.campaign;
  const cities = pick ? await query<{ city: string; n: number; verified: number }>(
    `SELECT ifnull(city,'Unknown') AS city, count(*) AS n, sum(confidence >= 0.7) AS verified FROM people WHERE campaign = ? GROUP BY city ORDER BY n DESC`, pick) : [];
  const leads = pick ? await query<Lead>(
    `SELECT p.*, o.name AS business, o.website, o.rating, o.reviews,
       (SELECT group_concat(field || ':' || result, ' ') FROM verifications v WHERE v.ref_table = 'people' AND v.ref_id = p.id) AS checks
     FROM people p LEFT JOIN organizations o ON o.id = p.organization_id
     WHERE p.campaign = ? ${city ? "AND ifnull(p.city,'Unknown') = ?" : ""} ORDER BY p.confidence DESC NULLS LAST, p.name LIMIT 1000`,
    ...(city ? [pick, city] : [pick])) : [];

  return (
    <>
      <PageHead title="Leads">Business contacts collected for a research brief, checked by the verifier. Every row links to the public page it came from.</PageHead>
      {campaigns.length > 1 ? (
        <Filters base="/leads" param="campaign" current={pick} options={campaigns.map((c) => ({ value: c.campaign, label: `${c.campaign} (${c.n})` }))} />
      ) : null}
      {pick ? (
        <>
          <Section title={`By city: ${pick}`} sub="Green is how many the verifier is at least 70% sure about.">
            <div className="panel panel-pad" style={{ display: "grid", gap: 10 }}>
              {cities.map((c) => (
                <a key={c.city} href={`/leads?campaign=${encodeURIComponent(pick)}&city=${encodeURIComponent(c.city)}`} style={{ textDecoration: "none", display: "grid", gridTemplateColumns: "130px 1fr 90px", gap: 12, alignItems: "center" }} aria-current={city === c.city ? "true" : undefined}>
                  <b>{c.city}</b>
                  <div className="bar" aria-hidden="true">
                    <i style={{ width: `${(c.n / Math.max(...cities.map((x) => x.n))) * 100}%`, background: "var(--lead)", opacity: 0.3 }} />
                    <i style={{ width: `${(Number(c.verified ?? 0) / Math.max(...cities.map((x) => x.n))) * 100}%`, background: "var(--lead)" }} />
                  </div>
                  <span className="small" style={{ color: "var(--muted)", textAlign: "right" }}>{c.verified ?? 0} of {c.n}</span>
                </a>
              ))}
            </div>
            {city ? <p className="small"><a href={`/leads?campaign=${encodeURIComponent(pick)}`}>Show every city</a></p> : null}
          </Section>

          <Section title={`${leads.length} contacts${city ? ` in ${city}` : ""}`} sub="To get a spreadsheet, ask Claude Code to export the leads. Numbers must be checked against the DND registry before any sales call or message.">
            <div className="panel table-wrap">
              <table className="t cards">
                <thead><tr><th>Name</th><th>Business</th><th>Phone</th><th>Email</th><th>Area</th><th>Rating</th><th>How sure</th><th>Source</th></tr></thead>
                <tbody>
                  {leads.map((l) => (
                    <tr key={l.id}>
                      <td data-label="Name" className="strong">{l.name}{l.role ? <div className="small">{l.role}</div> : null}{l.opt_out ? <Badge value="opted out" kind="bad" /> : null}</td>
                      <td data-label="Business">{l.website ? <ExtLink href={l.website.startsWith("http") ? l.website : `https://${l.website}`}>{l.business}</ExtLink> : l.business}</td>
                      <td data-label="Phone" style={{ whiteSpace: "nowrap" }}>{l.phone_e164}{l.phone_type ? <div className="small">{l.phone_type}</div> : null}</td>
                      <td data-label="Email">{l.email}{l.email ? <div><Badge value={l.email_status} /></div> : null}</td>
                      <td data-label="Area">{[l.locality, l.city].filter(Boolean).join(", ")}</td>
                      <td data-label="Rating" className="num">{l.rating ? `${l.rating} (${l.reviews ?? 0})` : ""}</td>
                      <td data-label="How sure">{confidenceBadge(l.confidence)}{l.checks ? <div className="small">{l.checks}</div> : null}</td>
                      <td data-label="Source" className="small"><ExtLink href={l.source_url}>open</ExtLink><div>{day(l.updated_at)}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      ) : (
        <div className="panel"><Empty title="No lead research yet">Run /hunt-engine:lead-research in Claude Code, say who you are looking for and where, and the researcher starts collecting.</Empty></div>
      )}
    </>
  );
}
