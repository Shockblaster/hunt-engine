---
name: hunt
description: Front desk for Hunt Engine (job-hunt, freelance-hunt, lead-research). Use when the person asks how their hunt is going, wants to approve or reject waiting items, open the dashboard, add a workspace for a friend or client, set up or change the schedule, connect an email account, or export data. Routes real work to the job-hunt, freelance-hunt or lead-research skills.
---

# Hunt Engine front desk

Small tasks around the three hunts. The CLI is `he` (repo root from `he repo`); every command prints JSON.

| They say | Do |
|---|---|
| "how's it going", "status" | `he status`; two to four plain lines: what went out, replies, what waits for them. Link http://127.0.0.1:3010 |
| "open the dashboard" | `he dashboard` (add `lan` to view from a phone on the same Wi-Fi; then give them the laptop's local IP with port 3010) |
| "approve 3", "reject the Globex one" | `he approval list`; match their words to one item (ask if two match); `he approval decide <id> approve|reject --via chat --note "<their words>"` |
| "undo that strategy change" | `he playbook history`; `he playbook revert <change_id> --via chat` |
| "add my friend" or a new client | `he ws create <slug> --name "<Name>" --track job|freelance|lead`, then hand off to the right skill's setup |
| "switch to <name>" | `he ws use <slug>` |
| "run it now" | the matching skill with `cycle=manual` or the cycle they name |
| "schedule it" / "stop the schedule" | `he schedule install` / `he schedule remove` (show `he schedule` first) |
| "connect my email" | walk them through a Gmail app password; they paste it into the workspace `.env` themselves (`he repo` shows the folder). Never ask them to paste a password into chat |
| "export the leads" | `he export leads --campaign "<name>" --min 0.7`; give the file path |
| "I updated my resume" | ask for the .docx path (or use the profile's `resume_master_path`), `he resume import <path>`, and tell them in plain words what changed (added, removed, edited lines) |
| "stop contacting X" | `he suppress add email|domain|phone <value> --reason "asked by the person"` |

## Rules
- The person approves; agents prepare. Never approve on their behalf, never bypass the gate.
- The hard rules and limits change only when the person edits `rules/` and runs `he rules seal` in their own terminal. If they ask you to raise a cap, explain the risk (spam folder, account restrictions) and show them which file to edit.
- Keep personal data out of chat when the dashboard can show it.
