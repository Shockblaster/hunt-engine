# Changelog

## 0.2.0 (2026-10-31)
- **Resume system:**
  - Your resume (.docx) becomes a master. Each line is a claim with a stable id, and re-importing a newer resume shows what changed.
  - Format is chosen per company: pages, paper, PDF or Word, sections.
  - One renderer writes both PDF and Word and trims to the page count. Rewrites cannot add numbers or names. Every build is fact-checked.
  - Cover letters use the same pipeline.
- **Lead research:**
  - The fast Google Maps collector wraps gosom/google-maps-scraper; installing it asks before downloading.
  - A pincode area filter, a website contact reader and India Post pincode lookups.
  - Formatted Excel exports with one sheet per city.
- **Job sources:** YC's hiring list with team size; job boards found from careers pages and swept daily; headcount lookup; email patterns learned per company, with bounces marking bad patterns.
- **Experiments:** variants are handed out by the engine, and a winner is called with a two-proportion test.
- **Freelance:** homepage mock-ups, listing before/after cards, reel-hook sheets, proposals, and one-tap WhatsApp and call buttons.
- **Practice tests:** every agent with tests (tailor, QA gate, inbox, verifier) is checked after a strategy change, and a failure undoes the change.
- **Operations:** `he doctor`, `he notify` (email to yourself, Jarvis voice), `he backup`, the time and cost of scheduled runs, and a Health page on the dashboard.
- **Dashboard:** phone card layouts for records, one-tap phone tasks, the Health page, and a LAN mode that needs a key.
- **Hardening after an independent review:**
  - The gate decides from the stored item, and approvals are tied to the exact content.
  - Only the person approves.
  - LinkedIn and portal actions are claimed before clicking.
  - Agents cannot mark anything as sent.

## 0.1.0 (2026-10-31)
First version: engine, gate, Gmail sending and reading, 17 agents, 4 skills, local dashboard, scheduler, sealed hard rules.
