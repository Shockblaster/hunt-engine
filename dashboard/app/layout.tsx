import type { Metadata } from "next";
import { Overpass } from "next/font/google";
import Link from "next/link";
import { cookies } from "next/headers";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { WorkspaceSwitcher } from "@/components/WorkspaceSwitcher";
import { count, currentWorkspace, one, readConfig } from "@/lib/db";
import { ago } from "@/lib/format";

const overpass = Overpass({ subsets: ["latin"], variable: "--font-overpass", weight: ["400", "500", "600", "700", "800"] });

export const metadata: Metadata = { title: "Hunt Engine", description: "What your agents found, sent and learned", robots: { index: false } };
export const dynamic = "force-dynamic";

function Mark() {
  // Three lines meeting at one station: the three tracks.
  return (
    <svg className="brand-mark" viewBox="0 0 26 26" aria-hidden="true">
      <path d="M2 6 H10 L16 13" stroke="var(--job)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M2 20 H10 L16 13" stroke="var(--lead)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M16 13 H24" stroke="var(--freelance)" strokeWidth="3" fill="none" strokeLinecap="round" />
      <circle cx="16" cy="13" r="3.5" fill="var(--surface)" stroke="var(--ink)" strokeWidth="2" />
    </svg>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const ws = await currentWorkspace();
  const cfg = readConfig();
  const options = Object.entries(cfg.workspaces).map(([slug, w]) => ({ slug, name: w.name }));
  const pending = ws ? await count(`SELECT count(*) AS n FROM approvals WHERE status = 'pending'`) : 0;
  const lastRun = ws ? await one<{ started_at: string; status: string }>(`SELECT started_at, status FROM runs WHERE parent_id IS NULL ORDER BY id DESC LIMIT 1`) : undefined;
  const demo = ws ? await one<{ value: string }>(`SELECT value FROM meta WHERE key = 'demo'`) : undefined;
  const flash = (await cookies()).get("he_flash")?.value;

  return (
    <html lang="en" className={overpass.variable}>
      <body>
        <div className="shell">
          <aside className="side">
            <Link href="/" className="brand"><Mark />Hunt Engine</Link>
            {ws ? <WorkspaceSwitcher current={ws.slug} options={options} /> : null}
            <Nav pending={pending} />
            <div className="side-foot">
              {lastRun ? `Agents last worked ${ago(lastRun.started_at)}` : "Agents have not run yet"}
              <br />Changes only through Claude Code
            </div>
          </aside>
          <main className="main">
            <div className="mobile-top">
              <Link href="/" className="brand"><Mark />Hunt Engine</Link>
              {ws ? <WorkspaceSwitcher current={ws.slug} options={options} /> : null}
            </div>
            {demo?.value === "1" ? (
              <div className="demo-banner">This is demo data made up to show the layout. None of these companies, people or messages are real.</div>
            ) : null}
            {flash ? <div className="demo-banner" role="status">{flash}</div> : null}
            {ws ? children : <NoWorkspace />}
          </main>
        </div>
      </body>
    </html>
  );
}

function NoWorkspace() {
  return (
    <div className="page-head">
      <h1>No hunt set up yet</h1>
      <p>Open Claude Code and run <code>/hunt-engine:job-hunt</code>, <code>/hunt-engine:freelance-hunt</code> or <code>/hunt-engine:lead-research</code>. The intake agent will ask a few questions and create your workspace; this page fills in as the agents work.</p>
    </div>
  );
}
