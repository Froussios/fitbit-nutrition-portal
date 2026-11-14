/**
 * Meal prep and saved meal storage in D1 (DR-24). Every query is limited to one user, whose ID the caller
 * took from a verified token. Nothing here copies the diary.
 */

import { FRACTION_EPSILON, KEEP_ENDED_MS, type Prep, type PrepIngredient, type PrepPortion, type PortionState } from "../src/core/prep";
import type { SavedMeal } from "../src/core/meal";
import type { D1Database } from "./d1";

interface PrepRow {
  id: string;
  name: string;
  ingredients: string;
  created_at: number;
  updated_at: number;
  discarded_at: number | null;
}

interface PortionRow {
  id: string;
  prep_id: string;
  fraction: number;
  entry_id: string | null;
  state: PortionState;
  eaten_at: number;
  created_at: number;
}

/**
 * The most space one user's preps and saved meals may take, in bytes (#91). Typical rows are about 4 KB, so this holds
 * hundreds; it bounds a crafted client, so that 100 users can't fill the free plan's 500 MB database.
 */
export const MAX_USER_BYTES = 2 * 1024 * 1024;
/** What each row counts for beyond its name and ingredients, so that many tiny rows can't slip under the cap. */
export const ROW_OVERHEAD = 512;

const rowBytes = `length(CAST(name AS BLOB)) + length(CAST(ingredients AS BLOB)) + ${ROW_OVERHEAD}`;

/**
 * Creates or replaces a recipe row in one statement, unless the user's preps and meals would then take more than
 * MAX_USER_BYTES. A save that doesn't grow the row always goes through, so a user over the cap can still rename and
 * trim. Ended preps count until they are deleted. Measured on SQLite: about 0.4 ms for a user at the cap, so the total
 * is worked out on each save rather than kept (which would cost a row written each time). True if saved.
 * Binds: ?1 user, ?2 id, ?3 name, ?4 ingredients JSON, ?5 now.
 */
async function saveWithinCap(db: D1Database, table: "preps" | "meals", userId: string, id: string, name: string, ingredients: string, now: number): Promise<boolean> {
  const columns = table === "preps" ? "user_id, id, name, ingredients, created_at, updated_at, discarded_at" : "user_id, id, name, ingredients, created_at, updated_at";
  const values = table === "preps" ? "?1, ?2, ?3, ?4, ?5, ?5, NULL" : "?1, ?2, ?3, ?4, ?5, ?5";
  const result = await db
    .prepare(
      `WITH incoming AS (SELECT length(CAST(?3 AS BLOB)) + length(CAST(?4 AS BLOB)) + ${ROW_OVERHEAD} AS size),
            existing AS (SELECT COALESCE((SELECT ${rowBytes} FROM ${table} WHERE user_id = ?1 AND id = ?2), 0) AS size),
            used AS (SELECT (SELECT COALESCE(SUM(${rowBytes}), 0) FROM preps WHERE user_id = ?1)
                          + (SELECT COALESCE(SUM(${rowBytes}), 0) FROM meals WHERE user_id = ?1) AS total)
       INSERT INTO ${table} (${columns})
       SELECT ${values} FROM incoming, existing, used
       WHERE incoming.size <= existing.size OR used.total - existing.size + incoming.size <= ?6
       ON CONFLICT (user_id, id) DO UPDATE SET name = excluded.name, ingredients = excluded.ingredients, updated_at = excluded.updated_at`,
    )
    .bind(userId, id, name, ingredients, now, MAX_USER_BYTES)
    .run();
  return result.meta.changes > 0;
}

const toPortion = (r: PortionRow): PrepPortion => ({ id: r.id, fraction: r.fraction, entryId: r.entry_id, state: r.state, eatenAt: r.eaten_at, createdAt: r.created_at });

export type ReserveResult =
  | { readonly kind: "reserved"; readonly portion: PrepPortion }
  | { readonly kind: "too-much"; readonly left: number }
  | { readonly kind: "no-prep" };

export class PrepStore {
  constructor(private readonly db: D1Database) {}

  /** The user's preps, with their portions. First deletes those that ended more than KEEP_ENDED_MS ago. */
  async list(userId: string, now: number): Promise<Prep[]> {
    const before = now - KEEP_ENDED_MS;
    const ended = `SELECT id FROM preps WHERE user_id = ?1 AND (
        (discarded_at IS NOT NULL AND discarded_at < ?2)
        OR id IN (SELECT prep_id FROM portions WHERE user_id = ?1 GROUP BY prep_id HAVING SUM(fraction) >= ?3 AND MAX(created_at) < ?2))`;
    // Preps first: deleting the portions first would stop a finished prep looking finished. The portions
    // then go with them (ON DELETE CASCADE), and the second statement also covers a database without it.
    await this.db.batch([
      this.db.prepare(`DELETE FROM preps WHERE user_id = ?1 AND id IN (${ended})`).bind(userId, before, 1 - FRACTION_EPSILON),
      this.db.prepare("DELETE FROM portions WHERE user_id = ?1 AND prep_id NOT IN (SELECT id FROM preps WHERE user_id = ?1)").bind(userId),
    ]);
    const [preps, portions] = await Promise.all([
      this.db.prepare("SELECT id, name, ingredients, created_at, updated_at, discarded_at FROM preps WHERE user_id = ?1 ORDER BY created_at").bind(userId).all<PrepRow>(),
      this.db.prepare("SELECT id, prep_id, fraction, entry_id, state, eaten_at, created_at FROM portions WHERE user_id = ?1 ORDER BY eaten_at, created_at").bind(userId).all<PortionRow>(),
    ]);
    const byPrep = new Map<string, PrepPortion[]>();
    for (const row of portions.results) {
      const list = byPrep.get(row.prep_id) ?? [];
      list.push(toPortion(row));
      byPrep.set(row.prep_id, list);
    }
    return preps.results.map((r) => ({
      id: r.id,
      name: r.name,
      ingredients: JSON.parse(r.ingredients) as PrepIngredient[],
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      discardedAt: r.discarded_at,
      portions: byPrep.get(r.id) ?? [],
    }));
  }

  /** Creates the prep, or replaces its name and ingredients. Portions already eaten keep their values. False if out of room. */
  save(userId: string, id: string, name: string, ingredients: readonly PrepIngredient[], now: number): Promise<boolean> {
    return saveWithinCap(this.db, "preps", userId, id, name, JSON.stringify(ingredients), now);
  }

  /** Discards the prep, or brings it back. False if the user has no such prep. */
  async setDiscarded(userId: string, id: string, discarded: boolean, now: number): Promise<boolean> {
    // Discarding twice keeps the first time, so a retry can't restart the 30 days.
    const result = await this.db
      .prepare("UPDATE preps SET discarded_at = CASE WHEN ?3 IS NULL THEN NULL ELSE COALESCE(discarded_at, ?3) END WHERE user_id = ?1 AND id = ?2")
      .bind(userId, id, discarded ? now : null)
      .run();
    return result.meta.changes > 0;
  }

  /**
   * Reserves a portion in one statement, so that no two requests can take more than the whole batch.
   * With no fraction it takes what is left. Sending the same portion ID again returns the first reservation.
   */
  async reserve(userId: string, prepId: string, portion: { id: string; fraction: number | null; entryId: string | null; eatenAt: number }, now: number): Promise<ReserveResult> {
    const inserted = await this.db
      .prepare(
        `WITH used AS (SELECT COALESCE(SUM(fraction), 0) AS total FROM portions WHERE user_id = ?1 AND prep_id = ?3),
              wanted AS (SELECT COALESCE(?4, 1 - used.total) AS fraction, used.total AS total FROM used)
         INSERT INTO portions (user_id, id, prep_id, fraction, entry_id, state, eaten_at, created_at)
         SELECT ?1, ?2, ?3, wanted.fraction, ?5, 'unconfirmed', ?6, ?7
         FROM preps, wanted
         WHERE preps.user_id = ?1 AND preps.id = ?3 AND preps.discarded_at IS NULL
           AND wanted.fraction > ?8 AND wanted.total + wanted.fraction <= 1 + ?8
         ON CONFLICT (user_id, id) DO NOTHING
         RETURNING id, prep_id, fraction, entry_id, state, eaten_at, created_at`,
      )
      .bind(userId, portion.id, prepId, portion.fraction, portion.entryId, portion.eatenAt, now, FRACTION_EPSILON)
      .all<PortionRow>();
    const row = inserted.results[0];
    if (row) return { kind: "reserved", portion: toPortion(row) };

    const existing = await this.db
      .prepare("SELECT id, prep_id, fraction, entry_id, state, eaten_at, created_at FROM portions WHERE user_id = ?1 AND id = ?2")
      .bind(userId, portion.id)
      .first<PortionRow>();
    if (existing && existing.prep_id === prepId) return { kind: "reserved", portion: toPortion(existing) };
    const prep = await this.db.prepare("SELECT discarded_at FROM preps WHERE user_id = ?1 AND id = ?2").bind(userId, prepId).first<{ discarded_at: number | null }>();
    if (!prep || prep.discarded_at !== null || existing) return { kind: "no-prep" };
    const used = await this.db.prepare("SELECT COALESCE(SUM(fraction), 0) AS total FROM portions WHERE user_id = ?1 AND prep_id = ?2").bind(userId, prepId).first<{ total: number }>();
    const left = 1 - (used?.total ?? 0);
    return { kind: "too-much", left: left < FRACTION_EPSILON ? 0 : left };
  }

  /** Marks a portion's diary entry as known to exist. False if the user has no such portion. */
  async confirm(userId: string, id: string, entryId: string): Promise<boolean> {
    const result = await this.db.prepare("UPDATE portions SET state = 'confirmed', entry_id = ?3 WHERE user_id = ?1 AND id = ?2").bind(userId, id, entryId).run();
    return result.meta.changes > 0;
  }

  /** Gives a portion back. Removing one that is already gone is not an error. */
  async remove(userId: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM portions WHERE user_id = ?1 AND id = ?2").bind(userId, id).run();
  }
}

interface MealRow {
  id: string;
  name: string;
  ingredients: string;
  created_at: number;
  updated_at: number;
}

/** Saved meals in D1. Every query is limited to one user, whose ID the caller took from a verified token. */
export class MealStore {
  constructor(private readonly db: D1Database) {}

  async list(userId: string): Promise<SavedMeal[]> {
    const rows = await this.db.prepare("SELECT id, name, ingredients, created_at, updated_at FROM meals WHERE user_id = ?1 ORDER BY created_at").bind(userId).all<MealRow>();
    return rows.results.map((r) => ({ id: r.id, name: r.name, ingredients: JSON.parse(r.ingredients) as PrepIngredient[], createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  /** Creates the meal, or replaces its name and ingredients. Entries already in the diary keep their values. False if out of room. */
  save(userId: string, id: string, name: string, ingredients: readonly PrepIngredient[], now: number): Promise<boolean> {
    return saveWithinCap(this.db, "meals", userId, id, name, JSON.stringify(ingredients), now);
  }

  /** Deleting a meal that is already gone is not an error. */
  async remove(userId: string, id: string): Promise<void> {
    await this.db.prepare("DELETE FROM meals WHERE user_id = ?1 AND id = ?2").bind(userId, id).run();
  }
}
