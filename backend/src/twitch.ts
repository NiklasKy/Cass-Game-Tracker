import type { Pool } from 'pg';

const HELIX_BASE = 'https://api.twitch.tv/helix';

type OAuthTokenRow = {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string;
  subject: string;
};

let appTokenCache: { token: string; expiresAt: number } | null = null;

export async function getAppAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (appTokenCache && appTokenCache.expiresAt - 60_000 > now) return appTokenCache.token;

  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials'
    }).toString()
  });

  if (!resp.ok) throw new Error(`Twitch app token failed: ${await resp.text()}`);
  const json = (await resp.json()) as any;
  const expiresIn = Number(json.expires_in ?? 3600);
  appTokenCache = { token: String(json.access_token), expiresAt: now + expiresIn * 1000 };
  return appTokenCache.token;
}

export async function getBroadcasterUser(pool: Pool, clientId: string, appToken: string, login: string) {
  const url = new URL(`${HELIX_BASE}/users`);
  url.searchParams.set('login', login);
  const json: any = await helixGet(url.toString(), clientId, appToken);
  const user = json?.data?.[0];
  if (!user?.id) throw new Error(`Broadcaster login not found: ${login}`);
  await pool.query(
    `INSERT INTO app_kv(key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    ['broadcaster_id', String(user.id)]
  );
  return { id: String(user.id), login: String(login) };
}

export async function getBroadcasterId(pool: Pool): Promise<string | null> {
  const r = await pool.query(`SELECT value FROM app_kv WHERE key='broadcaster_id'`);
  return r.rowCount ? String(r.rows[0].value) : null;
}

export async function getUserAccessToken(pool: Pool, clientId: string, clientSecret: string): Promise<string> {
  const r = await pool.query<OAuthTokenRow>(
    `SELECT subject, access_token, refresh_token, expires_at, scope
     FROM oauth_tokens WHERE provider='twitch'
     ORDER BY updated_at DESC LIMIT 1`
  );
  if (!r.rowCount) throw new Error('No Twitch user token found. Complete /oauth/start once.');
  const row = r.rows[0];
  const expiresAt = new Date(row.expires_at).getTime();
  const now = Date.now();

  if (expiresAt - 120_000 > now) return row.access_token;

  const refreshed = await refreshUserToken(clientId, clientSecret, row.refresh_token);
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000);
  const scope = Array.isArray(refreshed.scope) ? refreshed.scope.join(' ') : String(refreshed.scope ?? row.scope ?? '');

  await pool.query(
    `
    UPDATE oauth_tokens SET
      access_token=$1,
      refresh_token=$2,
      scope=$3,
      expires_at=$4,
      updated_at=NOW()
    WHERE provider='twitch' AND subject=$5
    `,
    [refreshed.access_token, refreshed.refresh_token, scope, newExpiresAt, row.subject]
  );

  return refreshed.access_token;
}

async function refreshUserToken(clientId: string, clientSecret: string, refreshToken: string) {
  const resp = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    }).toString()
  });
  if (!resp.ok) throw new Error(`Twitch token refresh failed: ${await resp.text()}`);
  return (await resp.json()) as any;
}

export async function helixGet(url: string, clientId: string, token: string) {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId
    }
  });
  if (!resp.ok) throw new Error(`Helix GET failed (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

export async function helixPost(url: string, clientId: string, token: string, body: unknown) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Client-Id': clientId,
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Helix POST failed (${resp.status}): ${await resp.text()}`);
  return resp.json();
}

export async function getLiveStreamGame(clientId: string, appToken: string, broadcasterId: string) {
  const url = new URL(`${HELIX_BASE}/streams`);
  url.searchParams.set('user_id', broadcasterId);
  const json: any = await helixGet(url.toString(), clientId, appToken);
  const stream = json?.data?.[0];
  if (!stream) return { categoryId: null, categoryName: 'Unknown' };
  const categoryId = stream.game_id ? String(stream.game_id) : null;
  const categoryName = stream.game_name ? String(stream.game_name) : 'Unknown';
  return { categoryId, categoryName };
}

export async function createEventSubSubscription(
  clientId: string,
  token: string,
  type: string,
  version: string,
  condition: Record<string, string>,
  sessionId: string
) {
  const url = `${HELIX_BASE}/eventsub/subscriptions`;
  const body = {
    type,
    version,
    condition,
    transport: { method: 'websocket', session_id: sessionId }
  };
  return helixPost(url, clientId, token, body);
}

