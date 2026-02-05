import { google } from 'googleapis';

export type GameAggregate = {
  game: string;
  lastStreamDate: Date;
  durationSeconds: number;
};

export async function upsertGamesToSheet(opts: {
  sheetId: string;
  tabName: string;
  serviceAccountJson: string;
  aggregates: GameAggregate[];
}) {
  const sa = JSON.parse(opts.serviceAccountJson);
  const auth = new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  await auth.authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  // Read existing A:C
  const readRange = `${opts.tabName}!A:C`;
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: opts.sheetId,
    range: readRange
  });

  const values = (existing.data.values ?? []) as any[][];
  const headerOffset = values.length ? 1 : 0;

  const rowByGameKey = new Map<string, number>(); // 1-based row number in sheet
  for (let i = headerOffset; i < values.length; i++) {
    const game = String(values[i]?.[0] ?? '').trim();
    if (!game) continue;
    const key = game.toLowerCase();
    if (!rowByGameKey.has(key)) rowByGameKey.set(key, i + 1);
  }

  const toUpdate: { row: number; a: string; b: string; c: number }[] = [];
  const toInsert: { a: string; b: string; c: number }[] = [];

  for (const agg of opts.aggregates) {
    const key = agg.game.trim().toLowerCase();
    const b = formatDateYmd(agg.lastStreamDate);
    const c = agg.durationSeconds / 86400; // Sheets duration (days)
    const row = rowByGameKey.get(key);
    if (row) toUpdate.push({ row, a: agg.game, b, c });
    else toInsert.push({ a: agg.game, b, c });
  }

  // Batch update existing rows: ONLY A-C
  if (toUpdate.length) {
    const data = toUpdate.map((u) => ({
      range: `${opts.tabName}!A${u.row}:C${u.row}`,
      values: [[u.a, u.b, u.c]]
    }));
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: opts.sheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        data
      }
    });
  }

  // Append new rows: ONLY A-C
  if (toInsert.length) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: opts.sheetId,
      range: `${opts.tabName}!A:C`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: toInsert.map((i) => [i.a, i.b, i.c])
      }
    });
  }
}

function pad2(n: number) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDateYmd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = pad2(d.getMonth() + 1);
  const dd = pad2(d.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

