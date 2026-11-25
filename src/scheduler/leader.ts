import type { Pool, PoolClient } from '../db/pool.js';

/** Arbitrary but fixed key for the keeper's advisory lock. */
export const KEEPER_LOCK_KEY = 0x4c554d454e; // "LUMEN"

/**
 * Leader election on a Postgres session advisory lock. Only one keeper process
 * holds the lock at a time; if it dies, its connection closes and the lock is
 * released, so another instance takes over on its next attempt.
 */
export class LeaderLock {
  private client: PoolClient | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly key: number = KEEPER_LOCK_KEY,
  ) {}

  get isLeader(): boolean {
    return this.client !== null;
  }

  /** Returns true if this process holds the lock after the call. */
  async acquire(): Promise<boolean> {
    if (this.client) {
      // Make sure the connection holding the lock is still alive.
      try {
        await this.client.query('SELECT 1');
        return true;
      } catch {
        this.client.release(true);
        this.client = null;
      }
    }
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [this.key]);
      if (rows[0]?.locked) {
        this.client = client;
        return true;
      }
    } catch (err) {
      client.release(true);
      throw err;
    }
    client.release();
    return false;
  }

  async release(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.query('SELECT pg_advisory_unlock($1)', [this.key]);
    } finally {
      this.client.release();
      this.client = null;
    }
  }
}
