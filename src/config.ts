import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().optional(),

  STELLAR_RPC_URL: z.string().url().default('https://soroban-testnet.stellar.org'),
  STELLAR_NETWORK_PASSPHRASE: z.string().default('Test SDF Network ; September 2015'),
  SUBSCRIPTION_CONTRACT_ID: z.string().regex(/^C[A-Z2-7]{55}$/, 'must be a contract strkey'),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  INDEXER_PAGE_SIZE: z.coerce.number().int().min(1).max(10_000).default(200),

  KEEPER_ENABLED: bool.default('false'),
  KEEPER_SECRET: z.string().regex(/^S[A-Z2-7]{55}$/, 'must be a secret seed').optional(),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  KEEPER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),

  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  WEBHOOK_ALLOW_PRIVATE_TARGETS: bool.default('false'),

  /** Comma-separated browser origins allowed to call the API, e.g. where lumensub-app runs. */
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const config = parsed.data;
  if (config.KEEPER_ENABLED && !config.KEEPER_SECRET) {
    throw new Error('Invalid configuration:\n  KEEPER_SECRET: required when KEEPER_ENABLED is true');
  }
  return config;
}
