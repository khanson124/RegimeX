import { z } from "zod";

/** Cursor pagination for large lists. Cursor is an opaque record id. */
export const cursorPaginationSchema = z.object({
  cursor: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50)
});

export type CursorPaginationInput = z.infer<typeof cursorPaginationSchema>;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}
