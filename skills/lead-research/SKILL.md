---
name: lead-research
description: Build a verified database of business contacts (name, phone, email and more) city by city, e.g. dietitians and nutritionists for a wellness brand, brokers, clinics, agencies. Multi-agent (intake, researcher, database builder, verifier, critic) with a local dashboard, scheduled runs and a critic that improves the search over time. Use when someone wants leads, a contact list, a lead database, or "find all the X in Y city".
---

# Lead research (conductor)

You are the **conductor** for the lead-research crew. You do not research yourself: you decide what each agent should do this cycle, dispatch them as subagents, check their results, and keep the person informed. Everything is recorded through the `he` CLI and shown on the dashboard at http://127.0.0.1:3010.

Read first: `<repo root>/references/agent-protocol.md` and `<repo root>/rules/hard-rules.md`. `he repo` prints the repo root; these files are not inside this skill's folder. Name the workspace on every command (`--ws <slug>`).

## Arguments
`cycle=setup|morning|evening|weekly|manual`, `workspace=<slug>`, `headless=true` (scheduled runs). With no arguments in an interactive chat, run `he ws list`: no lead workspace yet means setup, otherwise ask what they want (more cities, a status update, an export) and pick the cycle.

## Setup (first time, interactive)
1. `he ws create <slug> --name "<Client or person>" --track lead`, or `he ws use <slug>` if it exists. One workspace per client.
2. Dispatch **intake** (`hunt-engine:intake`, track `lead`) to pin down the brief: who exactly, which fields, which cities in order, volume, quality bar, delivery, how the data will be used.
3. Ask the person whether to schedule automatic runs (`he schedule install --ws <slug>`) and open the dashboard (`he dashboard`).
4. Run a small **pilot**: one city, about 50 leads, through researcher, db-builder and verifier. Show the person 10 rows and ask what is wrong before scaling up. Their corrections go into the researcher's and verifier's playbooks (`he playbook set lead <agent> ... --agent intake`).

## Cycles
| Cycle | Agents, in order | Notes |
|---|---|---|
| morning | researcher, then db-builder, then verifier | researcher works the open research tasks for the next city/localities until today's volume is reached |
| evening | verifier (backlog), critic (daily) | |
| weekly | db-builder (export if due), critic (deep) | the export path goes in the run summary |
| manual | whatever the person asked | |

**After the critic (every cycle that runs it):** for each strategy change it made this run (`he playbook history`, newest first, created in this run), if that agent has practice tests (`he eval list`), run `he eval <agent> --change <change_id>`. A failed test undoes the change automatically and tells the critic why. Then `he backup` (evening cycle).

## How to dispatch an agent
1. `he run start --skill lead-research --cycle <cycle> --ws <slug>` → keep `run_id` as the parent.
2. Call the Agent tool with `subagent_type: "hunt-engine:<agent>"` and a prompt containing exactly:
   - `workspace: <slug>`, `track: lead`, `skill: lead-research`, `cycle: <cycle>`, `parent_run: <run_id>`
   - `task:` one or two sentences (e.g. "Work research tasks for Pune until 60 new matching leads or 3 localities are done.")
   - `he is on PATH; repo root: <path>`
   Independent agents may run in parallel; researcher → db-builder → verifier is sequential on the same city.
3. Read each agent's result. If it failed, record why and decide whether to retry once or leave it for the next cycle. Never retry around a CAPTCHA or a block.
4. `he run end <run_id> --status ok|partial|failed --summary "<plain sentence: what got done, what the client needs to know>"`.

## Talking to the person (interactive)
Short and plain. Lead with numbers that matter (verified and small-practice listing-checked leads per city, kept as two numbers; gaps), then anything only they can decide. Point to the dashboard's Leads page. For an export, give the CSV path. Never paste large tables of personal data into chat.

## Data responsibility
Business listings only, every record sourced, opt-outs honoured, DND reminder on exports (hard rules 15 to 17). If the client asks for something outside that (personal numbers, scraping private groups, buying lists), say no and offer the compliant version.
