# Cold Email Tracker

A self-hosted CRM and automation dashboard for running personalised cold-email outreach to YouTube creators across multiple Gmail accounts. It pulls leads from Google Sheets, analyses each creator's channel through the YouTube Data API to find their outlier videos, drafts context-aware follow-ups with an LLM, schedules sends in Gmail with Playwright, and syncs replies back from Gmail so every lead's stage stays current. I built it to replace a patchwork of spreadsheets, n8n workflows and manual Gmail scheduling that was eating most of my week. It now runs my whole outreach pipeline from one screen.

## Results

| Metric | Value |
|---|---|
| Cold emails sent | ~100 / day |
| New leads processed | ~2,000 / month |
| Email touches (initial + follow-ups) | ~2,500 / month |
| Reply rate | ~4.5% |
| Manual work saved | 10–20 hours / week |

## Tech stack

- **Frontend:** React 19, TypeScript, React Router, lucide-react, PapaParse / SheetJS (CSV & XLSX import)
- **Backend:** Node.js, Express 5, a JSON-file persistence layer
- **Google APIs:** Gmail API (OAuth 2.0 with refresh tokens, multi-account), Google Sheets API (service account), YouTube Data API v3
- **AI:** Groq API (`openai/gpt-oss-120b`) for follow-up generation, with automatic key rotation when a key hits its daily quota
- **Automation:** Playwright driving persistent Chrome profiles in parallel for Gmail "Schedule send"; PowerShell helpers for Windows window management
- **Transcripts:** yt-dlp
- **Origin:** the YouTube data collection is a port of earlier n8n workflows into code

## How it works

```
 Google Sheets (lead source)
        │  Sheets API (service account)
        ▼
 ┌──────────────────────────────┐        YouTube Data API v3
 │  Express backend  :3006      │◄──────  channel stats, outlier videos,
 │                              │         transcripts (yt-dlp)
 │  • reasoning.js     outlier-video analysis per lead
 │  • ai-followup.js   LLM follow-ups (Groq) ◄──── angle rotation from the UI
 │  • gmail-sync.js    reply / thread sync  ◄────► Gmail API (N accounts)
 │  • send-stats.js    per-month, per-stage send history from Sent folders
 │  • auto-scheduler.js Playwright → Gmail "Schedule send" in every profile
 │  • db.js            JSON persistence (server/data.json)
 └──────────────┬───────────────┘
                │ REST
                ▼
 ┌──────────────────────────────┐
 │  React dashboard  :3005      │  Today · New/Old/Stale leads · Pipeline ·
 │                              │  Middle-of-funnel · Templates · Analytics ·
 │                              │  Goals · Draft Scheduler · Ideas · Accounts
 └──────────────────────────────┘
```

1. **Ingest.** Leads (creator email, channel, video) come in from Google Sheets or a CSV/XLSX import and are de-duplicated by email and channel ID.
2. **Research.** For each lead, the backend pulls recent uploads, computes a rolling-median baseline, and flags outlier videos (≥1.5× baseline). The result becomes the personalisation hook for the first email.
3. **Send and follow up.** Templates handle first touches. Middle-of-funnel follow-ups rotate through "angles" (new-video comparison, case study, guarantee, stepping back …), and the LLM writes each one from the lead's real numbers under strict no-hallucination rules.
4. **Schedule.** Drafts are created through the Gmail API. The auto-scheduler then opens every account's Chrome profile in parallel and schedules each draft at a randomised, human-looking time. It verifies each step and screenshots any failures.
5. **Sync.** Gmail threads are polled server-side to detect replies and move leads between New → Contacted → Replied / Stale, and to build send-volume analytics.

## Setup

**Prerequisites:** Node.js ≥ 20.12, Google Chrome, and a Google Cloud project with the Gmail, Sheets and YouTube Data v3 APIs enabled. Windows is assumed for the helper scripts (`start-app.bat`, `*.ps1`).

```bash
git clone https://github.com/<your-username>/cold-email-tracker.git
cd cold-email-tracker
npm install
npx playwright install chromium
cp .env.example .env        # then fill in your keys
```

Credentials:

1. **API keys.** Put your YouTube API key, Groq key(s) and Google Sheet ID in `.env`.
2. **Service account (Sheets).** Create a service account, download its JSON key to `server/keys/google-service-account.json`, and share your sheet with the service account's email. The `server/keys/` folder is gitignored.
3. **Gmail OAuth.** Create an OAuth "Web application" client with `http://localhost:3005` as an authorised origin and redirect URI. Enter the Client ID and Client Secret on the app's **Settings** page, then connect each sending account on **Accounts**.

Run it:

```bash
npm run server   # backend on http://localhost:3006
npm start        # frontend on http://localhost:3005
```

Or double-click `start-app.bat` to restart both in their own windows.

## Project structure

```
server/            Express API, Gmail/Sheets/YouTube integrations, schedulers
src/pages/         One React page per dashboard view
src/services/      API clients (Gmail OAuth, Sheets, Groq, CSV import)
src/utils/         Follow-up angle rotation, scheduling and stale-lead logic
.env.example       Every environment variable the app reads
```

## Notes

- All lead data, OAuth tokens and app state live locally in `server/data.json`, which is gitignored. Nothing is sent anywhere except Google's and Groq's APIs.
- Built for personal use. Respect Gmail sending limits and anti-spam laws (CAN-SPAM / GDPR) if you adapt it.
