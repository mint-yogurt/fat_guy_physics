import {
  sanitizePlayerSave,
  sanitizeWorldSave,
  type PlayerSave,
  type WorldSave,
} from "./snapshot.ts";

/**
 * Where saves live: one player's view of storage.
 *
 * The game only ever talks to this, so where the bytes go is swappable:
 *
 *  - singleplayer: the browser (`client/src/save/browserSaveStore.ts`), where this
 *    machine is both the player and the "server";
 *  - multiplayer: a store on the server, built per connection for the player the
 *    connection's token proved they are. The world half is then the one shared world,
 *    and the client holds no save at all.
 *
 * Loads return already-sanitized data or undefined (nothing saved, or unreadable).
 * They never throw: a broken save must start a fresh game, not stop one. Saves may
 * reject; the saver reports it and tries again later.
 */
export interface SaveStore {
  loadPlayer(): Promise<PlayerSave | undefined>;
  savePlayer(save: PlayerSave): Promise<void>;
  loadWorld(): Promise<WorldSave | undefined>;
  saveWorld(save: WorldSave): Promise<void>;
  /** Forgets everything saved. */
  clear(): Promise<void>;
}

/**
 * Keeps saves in memory as JSON text, so what comes back has been through exactly the
 * serialize/parse/sanitize path a real store uses. Tests use it, and a server can
 * start from it.
 */
export class MemorySaveStore implements SaveStore {
  private player: string | undefined;
  private world: string | undefined;

  loadPlayer(): Promise<PlayerSave | undefined> {
    return Promise.resolve(parse(this.player, sanitizePlayerSave));
  }

  savePlayer(save: PlayerSave): Promise<void> {
    this.player = JSON.stringify(save);
    return Promise.resolve();
  }

  loadWorld(): Promise<WorldSave | undefined> {
    return Promise.resolve(parse(this.world, sanitizeWorldSave));
  }

  saveWorld(save: WorldSave): Promise<void> {
    this.world = JSON.stringify(save);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.player = undefined;
    this.world = undefined;
    return Promise.resolve();
  }
}

function parse<T>(text: string | undefined, sanitize: (raw: unknown) => T | undefined): T | undefined {
  if (text === undefined) return undefined;
  try {
    return sanitize(JSON.parse(text));
  } catch {
    return undefined;
  }
}
