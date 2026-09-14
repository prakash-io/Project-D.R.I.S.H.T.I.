import fs from 'node:fs';
import pg from 'pg';
import copyFrom from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';

const dbUrl = process.env.DATABASE_URL;
const table = process.argv[2];
const columns = process.argv[3];
const file = process.argv[4];

if (!dbUrl || !table || !file) {
  console.error("Usage: DATABASE_URL=... node run_copy.mjs <table> <columns> <csv_file>");
  process.exit(1);
}

const client = new pg.Client({ connectionString: dbUrl });

async function run() {
  await client.connect();
  console.log(`[copy] Connected to DB, streaming ${file} to ${table}...`);
  
  const stream = client.query(copyFrom.from(`COPY ${table} (${columns}) FROM STDIN WITH (FORMAT csv)`));
  const fileStream = fs.createReadStream(file);
  
  await pipeline(fileStream, stream);
  console.log(`[copy] Successfully loaded ${file} to ${table}`);
  await client.end();
}

run().catch(err => {
  console.error('[copy] Fatal:', err);
  process.exit(1);
});
