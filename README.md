# Cass Game Tracker (Collector)

This project collects Twitch stream category changes (game changes) and stores them in Postgres.
When a stream ends, it updates a Google Sheet with per-game totals and last played date.

## Why this approach

Third-party sites may be blocked or inconsistent. This collector records the data directly from Twitch events.

## Components

- `docker-compose.yml`: Postgres + collector service
- `backend/`: Node.js + TypeScript collector
- `backend/migrations/`: SQL migrations
- `docs/`: setup and deployment docs

## Setup

See `docs/SETUP.md`.

