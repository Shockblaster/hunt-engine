-- Hunt Engine core schema. One SQLite file per workspace (person or client).
-- Every table that agents write carries created_at; external actions are mirrored in activities.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- What the person wants, per track (job | freelance | lead). Latest version wins.
CREATE TABLE IF NOT EXISTS profiles (
  id         INTEGER PRIMARY KEY,
  track      TEXT NOT NULL CHECK (track IN ('job','freelance','lead')),
  version    INTEGER NOT NULL,
  data       TEXT NOT NULL,              -- JSON: goals, roles, cities, pay floor, dream list, exclusions
  created_by TEXT NOT NULL DEFAULT 'intake',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (track, version)
);

-- The only statements any outbound text may make about the person.
CREATE TABLE IF NOT EXISTS claims (
  id         INTEGER PRIMARY KEY,
  text       TEXT NOT NULL,
  evidence   TEXT NOT NULL,              -- where it is proven (resume line, link, document)
  contexts   TEXT NOT NULL DEFAULT 'all', -- comma list: job, freelance, lead, all
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS organizations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT UNIQUE,               -- normalised, e.g. acme.com
  website     TEXT,
  employees   INTEGER,
  is_listed   INTEGER NOT NULL DEFAULT 0,
  is_unicorn  INTEGER NOT NULL DEFAULT 0,
  is_mnc      INTEGER NOT NULL DEFAULT 0,
  is_brand    INTEGER NOT NULL DEFAULT 0,
  tier        TEXT NOT NULL DEFAULT 'unknown' CHECK (tier IN ('small','big','unknown')),
  tier_reasons TEXT,                     -- JSON array of strings
  sector      TEXT,
  city        TEXT,
  country     TEXT,
  phone       TEXT,
  phone_e164  TEXT,
  address     TEXT,
  rating      REAL,
  reviews     INTEGER,
  funding     TEXT,                      -- JSON: stage, amount, date, source
  campaign    TEXT,
  tags        TEXT,
  source_url  TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS org_name_city ON organizations (lower(name), ifnull(lower(city),'')) WHERE domain IS NULL;

CREATE TABLE IF NOT EXISTS people (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER REFERENCES organizations(id),
  name            TEXT NOT NULL,
  role            TEXT,
  linkedin_url    TEXT UNIQUE,
  email           TEXT UNIQUE,
  email_status    TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (email_status IN ('unknown','published','guessed','mx_ok','verified','bounced','invalid')),
  phone           TEXT,
  phone_e164      TEXT UNIQUE,
  phone_type      TEXT,
  city            TEXT,
  locality        TEXT,
  confidence      REAL,                  -- 0..1, set by the verifier
  opt_out         INTEGER NOT NULL DEFAULT 0,
  campaign        TEXT,
  tags            TEXT,
  source_url      TEXT NOT NULL,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS opportunities (
  id              INTEGER PRIMARY KEY,
  track           TEXT NOT NULL CHECK (track IN ('job','freelance','lead')),
  kind            TEXT NOT NULL,         -- job | internship | prospect | lead
  organization_id INTEGER REFERENCES organizations(id),
  person_id       INTEGER REFERENCES people(id),
  title           TEXT NOT NULL,
  url             TEXT,
  dedupe_key      TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,         -- greenhouse, wellfound, maps, ...
  location        TEXT,
  remote          INTEGER,
  pay_text        TEXT,
  posted_at       TEXT,
  description     TEXT,
  snapshot_path   TEXT,
  fit_score       REAL,
  fit_reasons     TEXT,                  -- JSON
  tier            TEXT,
  stage           TEXT NOT NULL DEFAULT 'found'
                  CHECK (stage IN ('found','shortlisted','skipped','preparing','pending_review','applied',
                                   'contacted','replied','interview','offer','won','lost','closed')),
  skip_reason     TEXT,
  campaign        TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id                INTEGER PRIMARY KEY,
  opportunity_id    INTEGER NOT NULL REFERENCES opportunities(id),
  portal            TEXT NOT NULL,
  resume_path       TEXT,
  cover_letter_path TEXT,
  answers           TEXT,                -- JSON of form field -> answer
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','pending_review','approved','rejected','submitted','failed','withdrawn')),
  submitted_at      TEXT,
  result            TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY,
  track           TEXT NOT NULL,
  channel         TEXT NOT NULL CHECK (channel IN ('email','linkedin_connect','linkedin_dm','portal','whatsapp','call')),
  direction       TEXT NOT NULL CHECK (direction IN ('out','in')),
  account         TEXT,                  -- sending or receiving account
  person_id       INTEGER REFERENCES people(id),
  organization_id INTEGER REFERENCES organizations(id),
  opportunity_id  INTEGER REFERENCES opportunities(id),
  thread_key      TEXT,
  to_address      TEXT,
  subject         TEXT,
  body            TEXT NOT NULL,
  variant         TEXT,                  -- JSON tags the critic measures: angle, subject_style, length, sample, source
  sequence_step   INTEGER NOT NULL DEFAULT 0, -- 0 = first touch, 1.. = follow-ups
  status          TEXT NOT NULL DEFAULT 'drafted'
                  CHECK (status IN ('drafted','pending_review','approved','queued','sent','failed','bounced','received','cancelled')),
  reply_class     TEXT,                  -- positive | interview | question | referral | rejection | ooo | auto | unsubscribe | other
  external_id     TEXT UNIQUE,           -- Message-ID or platform id
  in_reply_to     TEXT,
  sent_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS messages_sent ON messages (account, channel, sent_at);

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('follow_up','apply','research','prep','user_action','verify')),
  title      TEXT NOT NULL,
  due_at     TEXT,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  ref_table  TEXT,
  ref_id     INTEGER,
  agent      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  done_at    TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id           INTEGER PRIMARY KEY,
  ref_table    TEXT NOT NULL,
  ref_id       INTEGER NOT NULL,
  summary      TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_via  TEXT,                     -- dashboard | chat | voice
  note         TEXT,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  UNIQUE (ref_table, ref_id)
);

CREATE TABLE IF NOT EXISTS suppression (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email','domain','phone','linkedin')),
  value      TEXT NOT NULL UNIQUE,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY,
  skill      TEXT NOT NULL,
  cycle      TEXT NOT NULL,
  agent      TEXT NOT NULL DEFAULT 'conductor',
  parent_id  INTEGER REFERENCES runs(id),
  status     TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','partial','failed')),
  summary    TEXT,
  counts     TEXT,                       -- JSON
  error      TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT
);

-- Append-only audit of everything that happened. external = 1 for actions seen outside this machine.
CREATE TABLE IF NOT EXISTS activities (
  id        INTEGER PRIMARY KEY,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  run_id    INTEGER REFERENCES runs(id),
  agent     TEXT NOT NULL,
  action    TEXT NOT NULL,
  ref_table TEXT,
  ref_id    INTEGER,
  detail    TEXT,
  external  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS activities_at ON activities (at);

-- The blackboard agents use to talk to each other.
CREATE TABLE IF NOT EXISTS agent_notes (
  id         INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent   TEXT NOT NULL,              -- an agent name or 'all'
  topic      TEXT NOT NULL,
  body       TEXT NOT NULL,
  ref_table  TEXT,
  ref_id     INTEGER,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','read','done')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playbooks (
  id         INTEGER PRIMARY KEY,
  track      TEXT NOT NULL,              -- job | freelance | lead | global
  agent      TEXT NOT NULL,
  version    INTEGER NOT NULL,
  content    TEXT NOT NULL,
  reason     TEXT NOT NULL,
  created_by TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (track, agent, version)
);

CREATE TABLE IF NOT EXISTS experiments (
  id         INTEGER PRIMARY KEY,
  track      TEXT NOT NULL,
  dimension  TEXT NOT NULL,              -- variant key being tested, e.g. angle
  variants   TEXT NOT NULL,              -- JSON array of variant values
  metric     TEXT NOT NULL DEFAULT 'positive_reply_rate',
  min_n      INTEGER NOT NULL DEFAULT 25,
  status     TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','concluded','stopped')),
  result     TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT
);

CREATE TABLE IF NOT EXISTS strategy_changes (
  id               INTEGER PRIMARY KEY,
  playbook_id      INTEGER NOT NULL REFERENCES playbooks(id),
  prev_playbook_id INTEGER REFERENCES playbooks(id),
  reason           TEXT NOT NULL,
  evidence         TEXT,                 -- JSON metrics behind the change
  reverted         INTEGER NOT NULL DEFAULT 0,
  reverted_via     TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS verifications (
  id         INTEGER PRIMARY KEY,
  ref_table  TEXT NOT NULL,
  ref_id     INTEGER NOT NULL,
  field      TEXT NOT NULL,
  method     TEXT NOT NULL,
  result     TEXT NOT NULL CHECK (result IN ('pass','fail','warn')),
  detail     TEXT,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
