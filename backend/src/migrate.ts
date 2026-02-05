import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPool } from './db.js';

async function main() {
  const pool = createPool();
  try {
    const file = join(process.cwd(), 'migrations', '001_init.sql');
    const sql = await readFile(file, 'utf8');
    await pool.query(sql);
    console.log('Migrations applied.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

