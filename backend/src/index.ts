import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { createPool } from './db.js';
import { getEnv } from './env.js';
import { applyMigrations } from './migrations.js';
import { encryptIfConfigured } from './crypto.js';
import {
  createEventSubSubscription,
  getAppAccessToken,
  getBroadcasterId,
  getBroadcasterUser,
  getLastAuthorizedUser,
  getLiveStreamGame,
  getUserAccessToken
} from './twitch.js';
import { upsertGamesToSheet } from './sheets.js';
import {
  closeOpenSegment,
  getActiveStream,
  getAggregatesForStream,
  getGlobalGameTotals,
  markStreamOffline,
  rotateSegment,
  startSegment,
  upsertStreamOnline
} from './segments.js';

function nowIso() {
  return new Date().toISOString();
}

function log(...args: any[]) {
  // eslint-disable-next-line no-console
  console.log(`[${nowIso()}]`, ...args);
}
function warn(...args: any[]) {
  // eslint-disable-next-line no-console
  console.warn(`[${nowIso()}]`, ...args);
}
function err(...args: any[]) {
  // eslint-disable-next-line no-console
  console.error(`[${nowIso()}]`, ...args);
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function text(res: http.ServerResponse, code: number, body: string) {
  res.statusCode = code;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

function requireAdmin(env: ReturnType<typeof getEnv>, req: http.IncomingMessage): boolean {
  const key = env.ADMIN_API_KEY;
  if (!key) return true; // not configured -> allow (dev)
  const provided = (req.headers['x-admin-key'] ?? '').toString();
  return provided === key;
}

function getRedirectUri(env: ReturnType<typeof getEnv>): string {
  // Allow explicit override to avoid redirect_mismatch issues across environments
  return env.TWITCH_REDIRECT_URI ?? `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/callback`;
}

async function exportTotalsToSheet(pool: ReturnType<typeof createPool>, env: ReturnType<typeof getEnv>) {
  const aggregates = await getGlobalGameTotals(pool);
  await upsertGamesToSheet({
    sheetId: env.GOOGLE_SHEET_ID,
    tabName: env.GOOGLE_SHEET_TAB_NAME,
    serviceAccountJson: env.GOOGLE_SERVICE_ACCOUNT_JSON,
    aggregates
  });
  return { games: aggregates.length };
}

async function main() {
  const env = getEnv();
  const pool = createPool();

  // Apply migrations at startup (idempotent)
  await applyMigrations(pool);

  const oauthState = crypto.randomBytes(16).toString('hex');

  const appToken = await getAppAccessToken(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
  const broadcaster = await getBroadcasterUser(pool, env.TWITCH_CLIENT_ID, appToken, env.TWITCH_BROADCASTER_LOGIN);

  // Recovery/bootstrap: ensure DB state matches current live state.
  await reconcileStreamState(pool, env, broadcaster.id, broadcaster.login);
  setInterval(() => {
    void reconcileStreamState(pool, env, broadcaster.id, broadcaster.login).catch((e) =>
      warn('[reconcile] failed', e?.message ?? String(e))
    );
  }, 5 * 60 * 1000);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return text(res, 400, 'Bad Request');
      const url = new URL(req.url, env.PUBLIC_BASE_URL);

      if (url.pathname === '/healthz') {
        return json(res, 200, { ok: true, time: nowIso() });
      }

      if (url.pathname === '/oauth/start') {
        // Broadcaster authorization for channel.update (category changes)
        // Scope chosen to allow reading updates via EventSub for channel metadata changes.
        const redirectUri = getRedirectUri(env);
        const authorize = new URL('https://id.twitch.tv/oauth2/authorize');
        authorize.searchParams.set('client_id', env.TWITCH_CLIENT_ID);
        authorize.searchParams.set('redirect_uri', redirectUri);
        authorize.searchParams.set('response_type', 'code');
        authorize.searchParams.set('scope', 'channel:manage:broadcast');
        authorize.searchParams.set('state', oauthState);
        res.statusCode = 302;
        res.setHeader('location', authorize.toString());
        return res.end();
      }

      if (url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || !state || state !== oauthState) return text(res, 400, 'Invalid OAuth state');

        const redirectUri = getRedirectUri(env);
        const tokenResp = await fetch('https://id.twitch.tv/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: env.TWITCH_CLIENT_ID,
            client_secret: env.TWITCH_CLIENT_SECRET,
            code,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri
          }).toString()
        });

        if (!tokenResp.ok) {
          const t = await tokenResp.text();
          return text(res, 500, `Token exchange failed: ${t}`);
        }
        const tokenJson = (await tokenResp.json()) as any;

        // Determine subject user id
        const userResp = await fetch('https://api.twitch.tv/helix/users', {
          headers: {
            Authorization: `Bearer ${tokenJson.access_token}`,
            'Client-Id': env.TWITCH_CLIENT_ID
          }
        });
        const userJson = (await userResp.json()) as any;
        const subject = userJson?.data?.[0]?.id;
        if (!subject) return text(res, 500, 'Failed to resolve user id');

        const expiresAt = new Date(Date.now() + (tokenJson.expires_in ?? 3600) * 1000);
        const scope = Array.isArray(tokenJson.scope) ? tokenJson.scope.join(' ') : String(tokenJson.scope ?? '');

        const encKey = env.TOKEN_ENCRYPTION_KEY;
        const accessToken = encryptIfConfigured(String(tokenJson.access_token), encKey);
        const refreshToken = encryptIfConfigured(String(tokenJson.refresh_token), encKey);

        await pool.query(
          `
          INSERT INTO oauth_tokens(provider, subject, access_token, refresh_token, scope, expires_at)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (provider, subject) DO UPDATE SET
            access_token = EXCLUDED.access_token,
            refresh_token = EXCLUDED.refresh_token,
            scope = EXCLUDED.scope,
            expires_at = EXCLUDED.expires_at,
            updated_at = NOW()
          `,
          ['twitch', subject, accessToken, refreshToken, scope, expiresAt]
        );

        return text(res, 200, 'OAuth complete. You can close this window.');
      }

      if (url.pathname === '/debug/state') {
        const broadcasterId = await getBroadcasterId(pool);
        const active = broadcasterId ? await getActiveStream(pool, broadcasterId) : null;
        return json(res, 200, {
          ok: true,
          broadcaster: { login: env.TWITCH_BROADCASTER_LOGIN, id: broadcasterId },
          activeStream: active
        });
      }

      if (url.pathname === '/oauth/whoami') {
        if (!requireAdmin(env, req)) return json(res, 403, { ok: false, error: 'Forbidden' });
        const who = await getLastAuthorizedUser(pool, env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
        return json(res, 200, {
          ok: true,
          authorizedUser: who,
          note: 'No tokens are returned by this endpoint.'
        });
      }

      if (url.pathname === '/debug/oauth') {
        if (!requireAdmin(env, req)) return json(res, 403, { ok: false, error: 'Forbidden' });
        return json(res, 200, {
          ok: true,
          twitchClientId: env.TWITCH_CLIENT_ID,
          publicBaseUrl: env.PUBLIC_BASE_URL,
          effectiveRedirectUri: getRedirectUri(env),
          note: 'Register effectiveRedirectUri exactly in the Twitch Developer Console.'
        });
      }

      if (url.pathname === '/admin/export-now') {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method Not Allowed' });
        if (!requireAdmin(env, req)) return json(res, 403, { ok: false, error: 'Forbidden' });
        const result = await exportTotalsToSheet(pool, env);
        return json(res, 200, { ok: true, ...result });
      }

      return text(res, 404, 'Not Found');
    } catch (e: any) {
      return json(res, 500, { ok: false, error: e?.message ?? String(e) });
    }
  });

  server.listen(8080, () => {
    log('[collector] listening on :8080');
    log('[collector] oauth:', `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/oauth/start`);
  });

  connectEventSub({
    pool,
    env,
    broadcasterId: broadcaster.id,
    broadcasterLogin: broadcaster.login
  }).catch((e) => err('[eventsub] fatal', e));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

async function connectEventSub(opts: {
  pool: ReturnType<typeof createPool>;
  env: ReturnType<typeof getEnv>;
  broadcasterId: string;
  broadcasterLogin: string;
}) {
  const { pool, env, broadcasterId, broadcasterLogin } = opts;

  const defaultWsUrl = 'wss://eventsub.wss.twitch.tv/ws';
  let active: WebSocket | null = null;
  let draining: WebSocket[] = [];
  let reconnectAttempts = 0;
  let reconnectTimer: NodeJS.Timeout | null = null;

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    clearReconnectTimer();
    reconnectAttempts += 1;
    const backoffMs = Math.min(30_000, 1000 * Math.pow(2, Math.min(5, reconnectAttempts - 1)));
    warn('[eventsub] scheduling reconnect in', backoffMs, 'ms');
    reconnectTimer = setTimeout(() => startSocket(defaultWsUrl), backoffMs);
  }

  function startSocket(url: string) {
    clearReconnectTimer();
    const socket = new WebSocket(url);
    const isDefault = url === defaultWsUrl;
    if (active) draining.push(active);
    active = socket;

    socket.on('open', () => log('[eventsub] ws open', isDefault ? '' : '(reconnect_url)'));

    socket.on('close', (code, reason) => {
      const reasonStr = reason ? reason.toString() : '';
      log('[eventsub] ws close', { code, reason: reasonStr });

      // If the active socket closes unexpectedly, reconnect.
      if (socket === active) {
        active = null;
        scheduleReconnect();
      }
    });

    socket.on('error', (e) => err('[eventsub] ws error', e));

    socket.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        const msgType = msg?.metadata?.message_type ?? 'unknown';
        await pool.query(`INSERT INTO events_raw(source, event_type, payload) VALUES ($1,$2,$3)`, [
          'eventsub_ws',
          msgType,
          msg
        ]);

        if (msgType === 'session_welcome') {
          const sessionId = msg?.payload?.session?.id;
          if (!sessionId) throw new Error('Missing session id in welcome');
          log('[eventsub] session', sessionId);

          // Successful welcome: reset reconnect backoff and close any draining sockets.
          reconnectAttempts = 0;
          clearReconnectTimer();
          draining.forEach((s) => {
            try {
              s.close();
            } catch {}
          });
          draining = [];

          try {
            await ensureSubscriptions(pool, env, sessionId, broadcasterId);
          } catch (e: any) {
            warn('[eventsub] subscription setup warning', e?.message ?? String(e));
          }
          return;
        }

        if (msgType === 'session_reconnect') {
          const reconnectUrl = msg?.payload?.session?.reconnect_url;
          if (reconnectUrl) {
            // Per Twitch docs, do NOT close the current connection immediately.
            // Connect to reconnect_url; Twitch will close the old socket after the new one is established.
            log('[eventsub] reconnecting');
            startSocket(reconnectUrl);
          }
          return;
        }

        if (msgType === 'notification') {
          await handleNotification(pool, env, broadcasterId, broadcasterLogin, msg);
        }
      } catch (e: any) {
        err('[eventsub] message handler error', e?.message ?? String(e));
      }
    });
  }

  startSocket(defaultWsUrl);
}

async function ensureSubscriptions(
  pool: ReturnType<typeof createPool>,
  env: ReturnType<typeof getEnv>,
  sessionId: string,
  broadcasterId: string
) {
  // Important: EventSub WebSocket transport requires a USER access token for subscription creation,
  // even for public topics like stream.online/offline.
  // Reference: https://discuss.dev.twitch.com/t/invalid-transport-and-auth-combination-error/59864
  const userToken = await getUserAccessToken(pool, env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);

  await safeCreateSub(env, userToken, 'stream.online', '1', { broadcaster_user_id: broadcasterId }, sessionId);
  await safeCreateSub(env, userToken, 'stream.offline', '1', { broadcaster_user_id: broadcasterId }, sessionId);
  await safeCreateSub(env, userToken, 'channel.update', '2', { broadcaster_user_id: broadcasterId }, sessionId);
}

async function safeCreateSub(
  env: ReturnType<typeof getEnv>,
  token: string,
  type: string,
  version: string,
  condition: Record<string, string>,
  sessionId: string
) {
  try {
    await createEventSubSubscription(env.TWITCH_CLIENT_ID, token, type, version, condition, sessionId);
    log('[eventsub] subscribed', type);
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // If the sub already exists, Helix may return 409. We treat it as OK.
    if (/409/.test(msg) || /Conflict/i.test(msg)) {
      log('[eventsub] subscription exists', type);
      return;
    }
    warn('[eventsub] subscribe failed', type, msg);
  }
}

async function handleNotification(
  pool: ReturnType<typeof createPool>,
  env: ReturnType<typeof getEnv>,
  broadcasterId: string,
  broadcasterLogin: string,
  msg: any
) {
  const subType = msg?.payload?.subscription?.type;
  const event = msg?.payload?.event;
  const at = event?.started_at || event?.ended_at || event?.timestamp || msg?.metadata?.message_timestamp;
  const ts = at ? new Date(at) : new Date();

  if (subType === 'stream.online') {
    const streamId = String(event?.id ?? `unknown_${ts.getTime()}`);
    await upsertStreamOnline(pool, streamId, broadcasterId, broadcasterLogin, ts);

    const appToken = await getAppAccessToken(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
    const game = await getLiveStreamGame(env.TWITCH_CLIENT_ID, appToken, broadcasterId);
    await startSegment(pool, streamId, game.categoryId, game.categoryName, ts);
    log('[segments] stream online', streamId, game.categoryName);
    return;
  }

  if (subType === 'channel.update') {
    const active = await getActiveStream(pool, broadcasterId);
    if (!active) return;
    const streamId = active.streamId;
    const categoryId = event?.category_id ? String(event.category_id) : null;
    const categoryName = event?.category_name ? String(event.category_name) : 'Unknown';
    await rotateSegment(pool, streamId, categoryId, categoryName, ts);
    log('[segments] rotate', streamId, categoryName);
    return;
  }

  if (subType === 'stream.offline') {
    const active = await getActiveStream(pool, broadcasterId);
    if (!active) return;
    const streamId = active.streamId;

    await closeOpenSegment(pool, streamId, ts);
    await markStreamOffline(pool, streamId, ts, 'offline_event');
    log('[segments] stream offline', streamId);

    // Write global totals: baseline + all collected segments
    await exportTotalsToSheet(pool, env);
    log('[sheets] updated from stream', streamId);
    return;
  }
}

async function reconcileStreamState(
  pool: ReturnType<typeof createPool>,
  env: ReturnType<typeof getEnv>,
  broadcasterId: string,
  broadcasterLogin: string
) {
  const active = await getActiveStream(pool, broadcasterId);

  const appToken = await getAppAccessToken(env.TWITCH_CLIENT_ID, env.TWITCH_CLIENT_SECRET);
  // If live, Helix streams response includes `id` and `started_at` and game fields.
  const resp: any = await (await fetch(`https://api.twitch.tv/helix/streams?user_id=${encodeURIComponent(broadcasterId)}`, {
    headers: { Authorization: `Bearer ${appToken}`, 'Client-Id': env.TWITCH_CLIENT_ID }
  })).json();
  const stream = resp?.data?.[0];
  const isLive = !!stream;

  if (isLive && !active) {
    const streamId = String(stream.id ?? `bootstrap_${Date.now()}`);
    const startedAt = stream.started_at ? new Date(stream.started_at) : new Date();
    const categoryId = stream.game_id ? String(stream.game_id) : null;
    const categoryName = stream.game_name ? String(stream.game_name) : 'Unknown';

    await upsertStreamOnline(pool, streamId, broadcasterId, broadcasterLogin, startedAt);
    await startSegment(pool, streamId, categoryId, categoryName, startedAt);
    log('[bootstrap] live stream detected', streamId, categoryName);
    return;
  }

  if (!isLive && active) {
    // We missed the offline event (collector was down). Finalize now.
    const ts = new Date();
    await closeOpenSegment(pool, active.streamId, ts);
    await markStreamOffline(pool, active.streamId, ts, 'recovered_offline');
    log('[reconcile] recovered offline stream', active.streamId);
    await exportTotalsToSheet(pool, env);
    log('[sheets] updated from recovered offline', active.streamId);
  }
}

