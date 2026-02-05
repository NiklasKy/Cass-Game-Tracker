# Collector service

This service:

- connects to Twitch EventSub via WebSocket
- stores events and derived stream/category segments in Postgres
- writes per-stream aggregates to Google Sheets when the stream ends

## Run locally (dev)

1. Create `.env` in the repo root (see `docs/SETUP.md`).
2. Start database:

```bash
docker compose up -d db
```

3. Install deps and run:

```bash
cd backend
npm install
npm run dev
```

