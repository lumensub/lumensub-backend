import { createApiKey } from '../api/keys.js';
import { createPool } from '../db/pool.js';

// Issues the first API key for a merchant. After that, merchants can manage their
// own keys through POST /v1/api-keys.
//
//   npm run keys:create -- G...MERCHANT "dashboard"

const [merchant, name = 'default'] = process.argv.slice(2);
if (!merchant || !/^G[A-Z2-7]{55}$/.test(merchant)) {
  console.error('usage: npm run keys:create -- <merchant G... address> [key name]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  // The merchant row normally comes from the indexer. Creating it here lets a
  // merchant get a key before their first plan is indexed.
  await pool.query('INSERT INTO merchants (address) VALUES ($1) ON CONFLICT DO NOTHING', [merchant]);
  const key = await createApiKey(pool, merchant, name);
  console.log(`API key for ${merchant} (${name}):\n\n  ${key.key}\n\nStore it now. Only its hash is kept.`);
} finally {
  await pool.end();
}
