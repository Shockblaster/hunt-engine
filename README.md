# Hunt Engine

Three Claude Code skills that run a crew of agents for you, on your own computer, for free:

| Skill | What the crew does |
|---|---|
| `/hunt-engine:job-hunt` | learns your goals, finds jobs and internships, tailors your resume per job, applies (big companies wait for your OK), asks employees for referrals, follows up, prepares you for interviews |
| `/hunt-engine:freelance-hunt` | learns your offer, finds clients with a visible need, makes quick samples, pitches them, follows up, turns replies into proposals |
| `/hunt-engine:lead-research` | builds a verified contact database city by city (for example dietitians in Mumbai, Pune and Bengaluru) |
| `/hunt-engine:hunt` | front desk: status, approvals, dashboard, schedule, exports |

Every action is recorded in a local database and shown on a dashboard at http://127.0.0.1:3010. A critic agent studies replies, rejections and silence every day and rewrites the other agents' strategies (you can undo any change). Hard rules that the critic cannot touch keep it honest: nothing invented about you, sending limits, approval for big companies, opt-outs honoured.

## Install (Windows or macOS)
Needs Node 24+, Google Chrome, Claude Code, and `uv` (for the LinkedIn, Indeed and Naukri search).

This repository is private. If you were invited, accept the invitation first (GitHub emails it to you, or open https://github.com/Shockblaster/hunt-engine/invitations), and make sure git can reach GitHub as you (`gh auth login`, or your usual git credentials).

```bash
git clone https://github.com/Shockblaster/hunt-engine.git hunt-engine && cd hunt-engine
npm install && npm link          # gives you the `he` command
claude plugin marketplace add "$(pwd)"      # Windows PowerShell: claude plugin marketplace add "$PWD"
claude plugin install hunt-engine@hunt-engine
he rules seal                    # once, in your own terminal
```

To update later: `cd hunt-engine && he upgrade`. Your own data never goes into this folder: workspaces, the database, your `.env` and browser logins live in `~/.hunt-engine`. Please do not push to `main`; send changes as a pull request.

Then open Claude Code and run `/hunt-engine:job-hunt` (or the freelance or lead skill). The intake agent asks a few questions and sets everything up.

## What only you can do
Agents are not allowed to sign up, log in, accept terms or solve CAPTCHAs for you. Setup asks you to:
- create a Gmail **app password** (Google Account > Security > 2-Step Verification > App passwords) and paste it into your workspace `.env` file yourself;
- for freelance or lead outreach, make a **separate Gmail** so a spam complaint never touches your main inbox;
- sign in once to each job portal you want used: `he browser https://wellfound.com/login` opens Chrome on your workspace's own profile.

## Everyday use
| You want | Do |
|---|---|
| see everything | `he dashboard` |
| approve what is waiting | the Approve button on the dashboard, or tell Claude "approve 3" |
| run automatically | `he schedule install` (09:15 apply and send, every 3 h inbox, 19:00 follow-ups and critic, Sunday review) |
| stop automatic runs | `he schedule remove` |
| export leads | `he export leads --campaign "<name>" --min 0.7` |
| add a friend or client | `he ws create <slug> --name "<Name>"` and run the skill for them |

## How it is built
- `engine/`: the `he` CLI (Node 24, built-in SQLite, no native modules). Database schema, the send gate (caps, warm-up, send window, pacing, suppression, approvals, fit floor), Gmail send and read, free job sources, PDF rendering, fact checks, scheduler.
- `agents/`: one file per specialist; `references/agent-protocol.md` is the contract they all follow.
- `skills/`: the conductors for each hunt and the front desk.
- `playbooks/`: starting strategies; live versions sit in each workspace's database and the critic edits them.
- `rules/`: the hard rules and limits, sealed by checksum. A hook blocks agents from editing them.
- `dashboard/`: Next.js app that only reads the database; approve, reject and revert go through `he`.
- Data lives in `~/.hunt-engine/workspaces/<name>/`: `db.sqlite`, `files/`, `browser/`, `.env`, `logs/`.

## Tests
`npm test` (engine). `node engine/demo.ts` builds a workspace of clearly fake demo data for trying the dashboard.

## Credits
Ideas borrowed, with thanks: [career-ops](https://github.com/career-ops-hq/career-ops) (MIT) for scoring and fact-checked CVs; coreyhaines31/marketingskills for cold-email practice; paramchoudhary/resumeskills for resume tailoring; gosom/google-maps-scraper (MIT) for the Maps approach; JobSpy (MIT) for job-board search; and lessons from a hand-run outreach sprint by Soham Agarwal.
