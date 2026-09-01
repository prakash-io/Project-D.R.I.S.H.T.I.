// Run all migrations against a remote PostgreSQL database using the pg driver.
// Usage: DATABASE_URL="postgresql://..." node run_migrations.mjs
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, 'migrations');

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL environment variable is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

async function run() {
  await client.connect();
  console.log('[migrate] connected to database');

  // Create the schema_migrations ledger if it doesn't exist
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      sha256     TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Get all migration files sorted
  const files = fs.readdirSync(migrationsDir)
    .filter(f => /^\d+.*\.sql$/.test(f))
    .sort();

  console.log(`[migrate] found ${files.length} migration files`);

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    const sha256 = crypto.createHash('sha256').update(sql).digest('hex');

    // Check if already applied
    const { rows } = await client.query(
      'SELECT sha256 FROM schema_migrations WHERE filename = $1',
      [file]
    );

    if (rows.length > 0) {
      if (rows[0].sha256 !== sha256) {
        console.error(`[migrate] ERROR: ${file} was already applied but contents changed!`);
        process.exit(1);
      }
      console.log(`[migrate] skipping ${file} (already applied)`);
      continue;
    }

    console.log(`[migrate] applying ${file}...`);
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)',
        [file, sha256]
      );
      console.log(`[migrate] ✓ ${file}`);
    } catch (err) {
      console.error(`[migrate] FAILED on ${file}:`, err.message);
      process.exit(1);
    }
  }

  // Verify
  const { rows: extRows } = await client.query(`
    SELECT extname, extversion FROM pg_extension
    WHERE extname IN ('postgis', 'pgrouting')
    ORDER BY extname;
  `);
  console.log('\n[migrate] Extensions:');
  extRows.forEach(r => console.log(`  ${r.extname} ${r.extversion}`));

  const { rows: tableRows } = await client.query(`
    SELECT count(*) AS tables FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
  `);
  console.log(`[migrate] Tables: ${tableRows[0].tables}`);

  console.log('[migrate] done');
  await client.end();
}

run().catch(err => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
