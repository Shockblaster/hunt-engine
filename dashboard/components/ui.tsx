import Link from "next/link";
import type { ReactNode } from "react";

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {children ? <p>{children}</p> : null}
    </header>
  );
}

export function Section({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {sub ? <p className="sub">{sub}</p> : null}
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <b>{title}</b>
      {children}
    </div>
  );
}

const TONE: Record<string, string> = {
  sent: "good", submitted: "good", replied: "good", interview: "good", offer: "good", won: "good", verified: "good", approved: "good", pass: "good", positive: "good", referral: "good", ok: "good", received: "good", published: "good", mx_ok: "good",
  pending_review: "meh", pending: "meh", drafted: "meh", draft: "meh", queued: "meh", preparing: "meh", guessed: "meh", warn: "meh", partial: "meh", question: "meh", running: "meh", open: "meh",
  bounced: "bad", failed: "bad", lost: "bad", rejected: "bad", rejection: "bad", invalid: "bad", fail: "bad", unsubscribe: "bad", cancelled: "plain",
};

const LABEL: Record<string, string> = {
  pending_review: "waiting for you", mx_ok: "domain takes mail", ooo: "out of office", linkedin_connect: "LinkedIn invite", linkedin_dm: "LinkedIn message",
};

export function Badge({ value, kind }: { value: string | number | null | undefined; kind?: string }) {
  if (value == null || value === "") return null;
  const v = String(value);
  const tone = kind ?? TONE[v] ?? "plain";
  return <span className={`badge ${tone}`}>{LABEL[v] ?? v.replace(/_/g, " ")}</span>;
}

export function Filters({ base, param, current, options }: { base: string; param: string; current: string | undefined; options: { value: string; label: string }[] }) {
  return (
    <div className="filters">
      {options.map((o) => {
        const active = (current ?? "") === o.value;
        const href = o.value ? `${base}?${param}=${encodeURIComponent(o.value)}` : base;
        return <Link key={o.value || "all"} href={href} aria-current={active ? "true" : undefined}>{o.label}</Link>;
      })}
    </div>
  );
}

export function ExtLink({ href, children }: { href: string | null | undefined; children: ReactNode }) {
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}
