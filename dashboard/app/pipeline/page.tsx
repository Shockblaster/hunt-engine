import Link from "next/link";
import { Badge, Empty, Filters, PageHead } from "@/components/ui";
import { query } from "@/lib/db";
import { day, TRACK_NAME } from "@/lib/format";

type Opp = {
  id: number; track: string; title: string; stage: string; fit_score: number | null; tier: string | null; source: string;
  org: string | null; org_id: number | null; location: string | null; updated_at: string; app_id: number | null; app_status: string | null;
};

const LANES: { stage: string[]; name: string }[] = [
  { stage: ["found", "shortlisted"], name: "Found" },
  { stage: ["preparing", "pending_review"], name: "Being prepared" },
  { stage: ["applied", "contacted"], name: "Applied or contacted" },
  { stage: ["replied"], name: "Replied" },
  { stage: ["interview"], name: "Interview or call" },
  { stage: ["offer", "won"], name: "Offer or won" },
  { stage: ["lost", "skipped", "closed"], name: "Closed" },
];

export default async function Pipeline({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const { track } = await searchParams;
  const opps = await query<Opp>(
    `SELECT o.id, o.track, o.title, o.stage, o.fit_score, coalesce(org.tier, o.tier) AS tier, o.source, org.name AS org, org.id AS org_id, o.location, o.updated_at,
       a.id AS app_id, a.status AS app_status
     FROM opportunities o LEFT JOIN organizations org ON org.id = o.organization_id
     LEFT JOIN applications a ON a.id = (SELECT max(id) FROM applications WHERE opportunity_id = o.id)
     WHERE o.track IN ('job','freelance') ${track ? "AND o.track = ?" : ""} ORDER BY o.fit_score DESC NULLS LAST, o.updated_at DESC LIMIT 600`,
    ...(track ? [track] : []),
  );

  return (
    <>
      <PageHead title="Pipeline">Every job and client opportunity, by how far it has got. Fit is the agents' score out of 5; anything under 3.5 is never sent.</PageHead>
      <Filters base="/pipeline" param="track" current={track} options={[{ value: "", label: "Both hunts" }, { value: "job", label: TRACK_NAME.job }, { value: "freelance", label: TRACK_NAME.freelance }]} />
      {opps.length ? (
        <div className="kanban">
          {LANES.map((lane) => {
            const items = opps.filter((o) => lane.stage.includes(o.stage));
            return (
              <div className="lane" key={lane.name}>
                <h3>{lane.name}<span>{items.length}</span></h3>
                {items.slice(0, 60).map((o) => (
                  <div className="card" key={o.id}>
                    <b>{o.app_id ? <Link href={`/pipeline/application/${o.app_id}`}>{o.title}</Link> : o.title}</b>
                    <div className="small">{o.org_id ? <Link href={`/companies/${o.org_id}`}>{o.org}</Link> : o.org ?? "Unknown company"}{o.location ? `, ${o.location}` : ""}</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>
                      {!track ? <Badge value={TRACK_NAME[o.track]} kind={o.track} /> : null}
                      {o.fit_score != null ? <Badge value={`fit ${o.fit_score}`} kind={o.fit_score >= 3.5 ? "good" : "bad"} /> : null}
                      {o.tier === "big" ? <Badge value="big company" kind="meh" /> : null}
                      {o.app_status ? <Badge value={o.app_status} /> : null}
                    </div>
                    <div className="small" style={{ marginTop: 4 }}>via {o.source}, {day(o.updated_at)}</div>
                  </div>
                ))}
                {items.length > 60 ? <div className="small">and {items.length - 60} more</div> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="panel"><Empty title="No opportunities yet">The scout adds them on its morning run.</Empty></div>
      )}
    </>
  );
}
