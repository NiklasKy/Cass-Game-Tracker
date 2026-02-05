import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';

export async function applyMigrations(pool: Pool) {
  // For now: single idempotent SQL file.
  const file = join(process.cwd(), 'migrations', '001_init.sql');
  const sql = await readFile(file, 'utf8');
  await pool.query(sql);
}

