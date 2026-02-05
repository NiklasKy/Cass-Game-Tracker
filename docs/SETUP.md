# Setup (Docker + Postgres + Twitch EventSub)

## 1) Prerequisites

- Docker + Docker Compose on your remote host
- A domain or public URL for OAuth redirect (e.g. `https://tracker.yourdomain.tld`)
- A Google Sheet with a tab named `Games` and headers in row 1:
  - `Game`
  - `Last Stream Date`
  - `Duration Played`
  - `Full Playtime generally`
  - `Ending`
  - `Finished`
  - `Continue`
  - `Info`

The collector must only update columns **A-C**.

## 2) Twitch Developer App

Create an app in the Twitch Developer Console.

- Client type: **Confidential**
- OAuth Redirect URL: `https://YOUR_PUBLIC_BASE_URL/oauth/callback`

## 3) Google Service Account

1. Create a Google Cloud service account.
2. Create a JSON key.
3. Share your Google Sheet with the service account email (edit access).

## 4) Configure environment

Copy `.env.example` to `.env` and fill:

- `PUBLIC_BASE_URL`
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

## 5) Start services

```bash
docker compose up -d --build
```

## 6) Run Twitch OAuth once (broadcaster login)

Open:

- `https://YOUR_PUBLIC_BASE_URL/oauth/start`

Complete authorization. The collector stores the broadcaster token in Postgres.

Notes:

- The collector can still track `stream.online` / `stream.offline` without OAuth.
- OAuth is required to subscribe to `channel.update` (category changes) reliably.

## 7) Verify

- Health check: `https://YOUR_PUBLIC_BASE_URL/healthz`
- Debug state: `https://YOUR_PUBLIC_BASE_URL/debug/state`

## Manual baseline (status quo)

Insert baseline rows manually into `baseline_games`:

```sql
INSERT INTO baseline_games (source, game_name, total_hours, last_seen_date, note)
VALUES ('twitchtracker_manual', 'ELDEN RING', 103, '2026-02-01', 'Copied from TwitchTracker table');
```

## Notes

On EventSub notifications the collector will:

- create a `streams` row when the stream goes online
- start/rotate `category_segments` on `channel.update`
- close the open segment and finalize the stream on `stream.offline`
- upsert Google Sheets `Games` tab **columns A–C only** when the stream ends

# Setup (Google Apps Script)

## 1) Create the Google Sheet

1. Create a Google Sheet.
2. Add a tab named `Games`.
3. Add the headers in row 1 (A1:H1) exactly as follows:

- Game
- Last Stream Date
- Duration Played
- Full Playtime generally
- Ending
- Finished
- Continue
- Info

**Important:** Columns D–H are manual and are never edited by the script.

## 2) Create a Twitch Developer application (Helix)

1. Open the Twitch Developer Console and create an application.
2. Copy the **Client ID** and **Client Secret**.

This script uses an **App Access Token** (Client Credentials flow). No user login is required.

## 3) Add the Apps Script

1. In the Google Sheet, open **Extensions → Apps Script**.
2. Create a new file named `Code.gs` and paste the contents from `apps-script/Code.gs` in this repo.
3. (Optional) Create/adjust `appsscript.json` from `apps-script/appsscript.json`.

## 4) Configure Script Properties

In Apps Script, open **Project Settings → Script properties** and set:

- `TWITCH_CLIENT_ID` = your Twitch app client id
- `TWITCH_CLIENT_SECRET` = your Twitch app client secret
- `TWITCH_CHANNEL_LOGIN` = `Cassia_Quing` (or another channel login)
- `LOOKBACK_DAYS` = e.g. `365` (how far back to scan VODs)

## 5) First run

1. Reload the spreadsheet.
2. Use the menu **Cass Tracker → Sync now**.
3. Authorize the script when prompted.

## 6) Automatic refresh

Run **Cass Tracker → Install daily trigger** once, or create a time-driven trigger manually.

## Optional: TwitchTracker channel 30-day summary

If you want a separate channel overview tab, run **Cass Tracker → Sync TwitchTracker 30d summary**.
This writes to a dedicated sheet named `Channel 30d` and does not touch the `Games` sheet.

## Optional: TwitchTracker games (scrape)

If Helix does not provide game/category metadata for your VODs, you can try
**Cass Tracker → Sync Games from TwitchTracker (scrape)**.

Important notes:

- This is **not an official API**. It works by downloading and parsing `https://twitchtracker.com/<channel>/games`.
- It may break any time if TwitchTracker changes layout or blocks automated requests.
- The script still only writes to columns **A-C** in the `Games` sheet.

In practice, TwitchTracker may block Apps Script with Cloudflare ("Just a moment...").

## Alternative workflow (recommended if games are missing in Helix)

1. Run **Cass Tracker → Sync VOD list (Helix)** to populate a `VODs` sheet.
2. Fill **`Manual Game`** in the `VODs` sheet (this column is never edited by the script).
3. Run **Cass Tracker → Recalculate Games from VOD tags** to update `Games` (columns A-C only).

## Duration Played format

`Duration Played` is stored as a **Sheets duration** value (fraction of a day) and formatted as `[h]:mm`.

## Limitations

- Twitch Helix `videos` listing is paginated and may not provide infinite history in one run.
- If you set a very large `LOOKBACK_DAYS`, the script may take longer; increase the time limit by running less frequently or reducing lookback.

## Troubleshooting

### Games show up as "Unknown"

Use **Cass Tracker → Debug: Fetch latest videos** and check the `Debug` sheet:

- If `Game ID` and `Game Name` are empty, Twitch did not provide category/game information for those VODs.
- If `Game Name` is present but the `Games` tab still shows `Unknown`, re-run sync after updating the script (sync prefers `game_name` when available).

