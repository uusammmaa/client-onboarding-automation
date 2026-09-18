import { SEED_ROWS } from "./demo-data";

/**
 * The demo tracker, kept in the browser.
 *
 * localStorage is an external store that React does not own, and `useSyncExternalStore`
 * is the API built for exactly that case: it uses `getServerSnapshot` during SSR and
 * hydration, then re-renders with the client snapshot. Reading it in an effect and
 * calling `setState` would work, but it cascades a render and trips the lint rule that
 * exists to catch it.
 *
 * Storage access throws in some private-browsing modes, so every read and write is
 * wrapped. A demo that blanks because storage is unavailable is worse than one that
 * quietly starts from the seed data.
 */

const KEY = "amrl.tracker.v1";

let cached: string[][] = SEED_ROWS;
let loaded = false;
const listeners = new Set<() => void>();

function read(): string[][] {
  try {
    const stored = window.localStorage.getItem(KEY);
    if (!stored) return SEED_ROWS;
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed) || parsed.length === 0) return SEED_ROWS;
    // Trust nothing that came out of storage; a half-written value must not crash the page.
    const rows = parsed.filter(
      (row): row is string[] => Array.isArray(row) && row.every((cell) => typeof cell === "string"),
    );
    return rows.length > 0 ? rows : SEED_ROWS;
  } catch {
    return SEED_ROWS;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export const rowStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  /**
   * Must return a stable reference between calls or React re-renders forever, which is
   * why the parsed value is cached rather than re-read on every snapshot.
   */
  getSnapshot(): string[][] {
    if (!loaded) {
      cached = read();
      loaded = true;
    }
    return cached;
  },

  getServerSnapshot(): string[][] {
    return SEED_ROWS;
  },

  set(rows: string[][]): void {
    cached = rows;
    loaded = true;
    try {
      window.localStorage.setItem(KEY, JSON.stringify(rows));
    } catch {
      // The page still works for this session.
    }
    emit();
  },

  reset(): void {
    cached = SEED_ROWS;
    loaded = true;
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      // Nothing to do.
    }
    emit();
  },
};
