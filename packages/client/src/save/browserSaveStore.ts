import type { SaveStore } from "@fgp/shared/save/saveStore";
import {
  sanitizePlayerSave,
  sanitizeWorldSave,
  type PlayerSave,
  type WorldSave,
} from "@fgp/shared/save/snapshot";

/**
 * Singleplayer saves, in this browser.
 *
 * The player (a couple of KB) goes in localStorage, which is synchronous and so is
 * the one write that reliably lands while the tab is closing. The world's edits can
 * be megabytes after a lot of digging, past localStorage's quota, so they go in
 * IndexedDB.
 *
 * Every failure (private window, blocked storage, quota) is swallowed on load, which
 * then reads as "nothing saved", and surfaced on save so the saver can say so.
 */

const PLAYER_KEY = "fgp.save.player";
const DB_NAME = "fgp-saves";
const DB_STORE = "world";
const WORLD_KEY = "singleplayer";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("indexedDB open failed"));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode);
      const request = run(transaction.objectStore(DB_STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error("indexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("indexedDB transaction aborted"));
    });
  } finally {
    db.close();
  }
}

export class BrowserSaveStore implements SaveStore {
  async loadPlayer(): Promise<PlayerSave | undefined> {
    try {
      const raw = localStorage.getItem(PLAYER_KEY);
      return raw === null ? undefined : sanitizePlayerSave(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  savePlayer(save: PlayerSave): Promise<void> {
    try {
      localStorage.setItem(PLAYER_KEY, JSON.stringify(save));
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  async loadWorld(): Promise<WorldSave | undefined> {
    try {
      return sanitizeWorldSave(await withStore("readonly", (store) => store.get(WORLD_KEY)));
    } catch {
      return undefined;
    }
  }

  async saveWorld(save: WorldSave): Promise<void> {
    await withStore("readwrite", (store) => store.put(save, WORLD_KEY));
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(PLAYER_KEY);
    } catch {
      // Nothing was stored there to begin with.
    }
    try {
      await withStore("readwrite", (store) => store.delete(WORLD_KEY));
    } catch {
      // Likewise.
    }
  }
}
