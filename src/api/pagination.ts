import { z } from 'zod';

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Opaque cursor from the previous page: the last id seen. */
  cursor: z
    .string()
    .regex(/^\d+$/)
    .optional(),
});

export type PageQuery = z.infer<typeof pageQuery>;

/**
 * Keyset pagination on a bigint id column, newest first. Fetches one extra row to
 * know whether another page exists.
 */
export function page<T extends { id: string }>(rows: T[], limit: number): { data: T[]; next_cursor: string | null } {
  const data = rows.slice(0, limit);
  return { data, next_cursor: rows.length > limit ? (data[data.length - 1]?.id ?? null) : null };
}
