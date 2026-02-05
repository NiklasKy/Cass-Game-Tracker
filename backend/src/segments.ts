import type { Pool } from 'pg';

export async function getActiveStream(pool: Pool, broadcasterId: string) {
  const r = await pool.query(
    `SELECT stream_id, started_at FROM streams
     WHERE broadcaster_id=$1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [broadcasterId]
  );
  if (!r.rowCount) return null;
  return { streamId: String(r.rows[0].stream_id), startedAt: new Date(r.rows[0].started_at) };
}

export async function upsertStreamOnline(pool: Pool, streamId: string, broadcasterId: string, broadcasterLogin: string, startedAt: Date) {
  await pool.query(
    `
    INSERT INTO streams(stream_id, broadcaster_id, broadcaster_login, started_at)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (stream_id) DO UPDATE SET
      broadcaster_id=EXCLUDED.broadcaster_id,
      broadcaster_login=EXCLUDED.broadcaster_login,
      started_at=LEAST(streams.started_at, EXCLUDED.started_at)
    `,
    [streamId, broadcasterId, broadcasterLogin, startedAt]
  );
}

export async function markStreamOffline(pool: Pool, streamId: string, endedAt: Date, reason: string) {
  await pool.query(
    `UPDATE streams SET ended_at=$2, ended_reason=$3 WHERE stream_id=$1`,
    [streamId, endedAt, reason]
  );
}

export async function getOpenSegment(pool: Pool, streamId: string) {
  const r = await pool.query(
    `SELECT id, category_id, category_name, started_at
     FROM category_segments
     WHERE stream_id=$1 AND ended_at IS NULL
     ORDER BY started_at DESC LIMIT 1`,
    [streamId]
  );
  if (!r.rowCount) return null;
  return {
    id: Number(r.rows[0].id),
    categoryId: r.rows[0].category_id ? String(r.rows[0].category_id) : null,
    categoryName: String(r.rows[0].category_name),
    startedAt: new Date(r.rows[0].started_at)
  };
}

export async function startSegment(pool: Pool, streamId: string, categoryId: string | null, categoryName: string, startedAt: Date) {
  await pool.query(
    `
    INSERT INTO category_segments(stream_id, category_id, category_name, started_at)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (stream_id, started_at, category_name) DO NOTHING
    `,
    [streamId, categoryId, categoryName, startedAt]
  );
}

export async function closeOpenSegment(pool: Pool, streamId: string, endedAt: Date) {
  const open = await getOpenSegment(pool, streamId);
  if (!open) return;
  const dur = Math.max(0, Math.floor((endedAt.getTime() - open.startedAt.getTime()) / 1000));
  await pool.query(
    `UPDATE category_segments SET ended_at=$2, duration_seconds=$3 WHERE id=$1`,
    [open.id, endedAt, dur]
  );
}

export async function rotateSegment(pool: Pool, streamId: string, nextCategoryId: string | null, nextCategoryName: string, at: Date) {
  const open = await getOpenSegment(pool, streamId);
  if (open && open.categoryName === nextCategoryName && (open.categoryId ?? null) === (nextCategoryId ?? null)) {
    return;
  }
  await closeOpenSegment(pool, streamId, at);
  await startSegment(pool, streamId, nextCategoryId, nextCategoryName, at);
}

export async function getAggregatesForStream(pool: Pool, streamId: string) {
  const r = await pool.query(
    `
    SELECT category_name, MAX(ended_at) AS last_seen, SUM(duration_seconds) AS total_seconds
    FROM category_segments
    WHERE stream_id=$1 AND duration_seconds IS NOT NULL
    GROUP BY category_name
    ORDER BY total_seconds DESC
    `,
    [streamId]
  );

  return r.rows.map((row) => ({
    game: String(row.category_name),
    lastStreamDate: row.last_seen ? new Date(row.last_seen) : new Date(),
    durationSeconds: Number(row.total_seconds ?? 0)
  }));
}

/**
 * Returns global totals per game: baseline (latest per game) + all recorded segments.
 *
 * baseline_games is treated as a "status quo snapshot" (latest row per game wins).
 * category_segments are summed across all finalized segments.
 */
export async function getGlobalGameTotals(pool: Pool) {
  const r = await pool.query(
    `
    WITH baseline AS (
      SELECT DISTINCT ON (lower(game_name))
        lower(game_name) AS k,
        game_name,
        COALESCE(total_hours, 0) AS total_hours,
        last_seen_date
      FROM baseline_games
      ORDER BY lower(game_name), inserted_at DESC
    ),
    seg AS (
      SELECT
        lower(category_name) AS k,
        category_name,
        MAX(ended_at) AS last_seen,
        SUM(duration_seconds)::bigint AS total_seconds
      FROM category_segments
      WHERE duration_seconds IS NOT NULL
      GROUP BY lower(category_name), category_name
    ),
    merged AS (
      SELECT
        COALESCE(seg.k, baseline.k) AS k,
        COALESCE(seg.category_name, baseline.game_name) AS game,
        (COALESCE(seg.total_seconds, 0)::bigint + (COALESCE(baseline.total_hours, 0) * 3600)::bigint) AS total_seconds,
        GREATEST(
          COALESCE(seg.last_seen, '1970-01-01'::timestamptz),
          COALESCE(baseline.last_seen_date::timestamptz, '1970-01-01'::timestamptz)
        ) AS last_seen
      FROM seg
      FULL OUTER JOIN baseline ON seg.k = baseline.k
    )
    SELECT game, total_seconds, last_seen
    FROM merged
    WHERE game IS NOT NULL
    ORDER BY total_seconds DESC, game ASC
    `
  );

  return r.rows.map((row) => ({
    game: String(row.game),
    durationSeconds: Number(row.total_seconds ?? 0),
    lastStreamDate: row.last_seen ? new Date(row.last_seen) : new Date(0)
  }));
}

