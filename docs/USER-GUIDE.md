# Hunt Engine: user guide

Hunt Engine runs a small team of AI agents on your own computer. They find opportunities, write to people, follow up, and keep a record you can read on a dashboard. You decide the important things; they do the rest.

## The three hunts
| Hunt | Start it with | It gives you |
|---|---|---|
| Job or internship | `/hunt-engine:job-hunt` | tailored resumes and applications, referral emails, follow-ups, interview prep |
| Freelance clients | `/hunt-engine:freelance-hunt` | prospects with a visible need, quick mock-ups, pitches, proposals |
| Lead research | `/hunt-engine:lead-research` | a checked contact list, city by city, as an Excel file |

The first run asks you questions: what you want, what is true about you, which accounts to use. Answer in plain words. Say "you decide" when you don't mind.

## What only you do
- **Passwords.** Create a Gmail app password and paste it into your workspace's `.env` file yourself. Agents never see your normal password and never type passwords.
- **Sign-ins.** Run `he browser https://wellfound.com/login` (or Naukri, Internshala, LinkedIn) and sign in once. The agents reuse that browser.
- **Approvals.** Anything going to a big company waits for you.
- **Phone tasks.** WhatsApp messages and calls arrive as a button on the dashboard with the words already written. You tap and send.

## Every day
- **Open the dashboard:** `he dashboard`, then go to http://127.0.0.1:3010. Today shows what happened and what needs you.
- **Approve or reject:** the buttons on Today, or tell Claude "approve the Globex one".
- **See it on your phone:** `he dashboard lan` prints a private link for your phone on the same Wi-Fi. Share it with nobody.
- **When your resume changes:** tell Claude "I updated my resume" and give it the new .docx. It shows you what changed and keeps everything in step.

## Running on its own
`he schedule install` sets up the automatic runs. Times are India time, and the laptop must be on.

| When | What happens |
|---|---|
| 09:40 | find, prepare and send |
| Every 3 hours, 8 am to 8 pm | read replies |
| 18:15 | follow-ups, the daily review and a backup |
| Sundays | the weekly review |

`he schedule remove` stops all of it.

## How it gets better
The critic reads every reply, rejection and silence. Once there is enough data (about 20 to 30 messages of a kind), it changes how the agents work and shows the change on the Critic page with an Undo button.

Every changed agent has to pass its practice test first. If it fails, the change is undone automatically.

## The rules it cannot break
- It never invents anything about you.
- Big companies need your approval.
- It respects daily sending limits and the send window.
- Anyone who asks not to be contacted is never contacted again.
- It never signs up, accepts terms or solves CAPTCHAs for you.

The rules live in `rules/`. Only you can change them, by editing the files and then running `he rules seal` in your own terminal.

## When something looks wrong
1. `he doctor` checks everything and says what to fix.
2. The dashboard's Health page shows which sources stopped working, the practice-test results and the automatic runs.
3. Every action is on the Activity page. Nothing is ever deleted from it.
