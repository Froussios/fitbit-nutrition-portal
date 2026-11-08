/**
 * The parts of Cloudflare's D1 binding the meal prep API uses, so that it needs no Cloudflare
 * type package and tests can stand in a local SQLite database.
 */

export interface D1Result<T = Record<string, unknown>> {
  readonly results: T[];
  readonly meta: { readonly changes: number };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /** Runs the statements as one transaction: all or none. */
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}
