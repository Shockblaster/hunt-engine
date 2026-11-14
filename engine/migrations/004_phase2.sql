-- Phase 2: resume system, company data, sources, evals, richer tasks.

ALTER TABLE organizations ADD COLUMN resume_format TEXT;   -- JSON: the format chosen for this company and why
ALTER TABLE organizations ADD COLUMN email_pattern TEXT;   -- e.g. first.last, learned from published addresses
ALTER TABLE organizations ADD COLUMN email_pattern_status TEXT; -- seen | bounced
ALTER TABLE organizations ADD COLUMN size_source TEXT;     -- where the headcount came from

ALTER TABLE applications ADD COLUMN resume_docx_path TEXT;
ALTER TABLE applications ADD COLUMN format TEXT;           -- JSON: pages, paper, files, trimmed bullets

ALTER TABLE claims ADD COLUMN source_ref TEXT;             -- the master-resume item this claim came from

ALTER TABLE tasks ADD COLUMN payload TEXT;                 -- JSON: e.g. phone, text, image for one-tap WhatsApp

-- Company job boards the scout sweeps every morning.
CREATE TABLE IF NOT EXISTS watchlist (
  id         INTEGER PRIMARY KEY,
  provider   TEXT NOT NULL CHECK (provider IN ('greenhouse','lever','ashby','workable','smartrecruiters','careers_page')),
  board      TEXT NOT NULL,
  company    TEXT NOT NULL,
  organization_id INTEGER REFERENCES organizations(id),
  added_by   TEXT NOT NULL DEFAULT 'scout',
  active     INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, board)
);

-- One row per source fetch, so dead or stale sources show up.
CREATE TABLE IF NOT EXISTS source_runs (
  id         INTEGER PRIMARY KEY,
  source     TEXT NOT NULL,
  target     TEXT,
  ok         INTEGER NOT NULL,
  items      INTEGER NOT NULL DEFAULT 0,
  error      TEXT,
  ms         INTEGER,
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS source_runs_at ON source_runs (source, at);

-- Agent practice tests.
CREATE TABLE IF NOT EXISTS evals (
  id         INTEGER PRIMARY KEY,
  agent      TEXT NOT NULL,
  case_name  TEXT NOT NULL,
  passed     INTEGER NOT NULL,
  score      REAL,
  detail     TEXT,
  trigger    TEXT NOT NULL DEFAULT 'manual',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);
