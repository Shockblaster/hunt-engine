# Hard rules

These rules bind every agent in every skill. The critic and the playbooks can never change them. `he rules verify` checks this file and `limits.json` against their sealed checksum; if the check fails, every send and submit is blocked until a person reseals the rules from an interactive terminal (`he rules seal`).

## 1. Truth
1. Never invent anything about the person: no skill, number, employer, title, result, location or anecdote. Every statement about them must trace to an active row in `claims`. If a JD asks for something the claims don't cover, leave it out or say plainly what they do have.
2. Never invent facts about a target (company, person, business). Personalisation must quote or paraphrase something with a source URL in the record.
3. Report outcomes honestly. Bounces, blocks, failures, CAPTCHAs and skipped steps are logged as such, never as success.

## 2. Consent and identity
4. Never create accounts, accept terms, tick consent or "I agree" boxes, or solve CAPTCHAs on a person's behalf. These go to the person as a `user_action` task.
5. If Claude Code's safety check, a portal, or a CAPTCHA blocks an autonomous submit or send, set the item to `pending_review` with the reason. Never retry around the block.
6. Never put a person's password, app password, token or `.env` content into the database, logs, messages or notes.

## 3. Who needs approval (job track)
7. Any application or outreach to a `big` tier organisation needs an approved row in `approvals` before it is submitted or sent. The tier rule is `engine/tier.ts` with the thresholds in `limits.json`.
8. Organisations of `unknown` tier are treated as `big` until the scout resolves them.
9. An opportunity with a fit score below `limits.json > min_fit` is never applied to or pitched, at any tier.

## 4. Sending limits
10. Every outbound email, LinkedIn action and portal submission goes through `he gate` first and is refused if it fails.
11. Daily caps and warm-up ramps per account and channel are in `limits.json`. Caps are never raised by an agent.
12. LinkedIn: connection requests go without a note by default, a maximum of `linkedin_connects_per_day`. Notes only for people the playbook marks top priority, within the monthly allowance. No bulk messaging and no scraping beyond reading pages a run needs.
13. One first-touch message per person per track. Follow-ups only in the same thread, at most `max_follow_ups`, and they stop at any reply.
14. Outbound freelance and lead emails carry a plain one-line opt-out.

## 5. Privacy and data
15. Every person and organisation record carries the `source_url` it came from. Collect only professional or business contact data that the person or business has published.
16. Anyone who asks not to be contacted, unsubscribes, or bounces hard goes into `suppression` at once and is never contacted again by any track.
17. Lead exports state the source of each record and carry a note that numbers must be checked against India's DND (NCPR) registry before any telemarketing call or message.

## 6. Writing
18. No em dashes in any outbound text. No fake familiarity ("I hope this finds you well", "I came across your profile and was impressed"). No claims of having used a product unless a claim says so.
