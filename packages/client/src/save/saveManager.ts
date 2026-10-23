import type { SaveStore } from "@fgp/shared/save/saveStore";
import type { PlayerSave, WorldSave } from "@fgp/shared/save/snapshot";

/** What the manager saves, as the game hands it over. */
export interface SaveSources {
  capturePlayer(): PlayerSave;
  captureWorld(): WorldSave;
  /** Changes whenever the world has something new to save (see `worldRevision`). */
  worldRevision(): string;
}

/** Seconds between checks. The player is written every time; the world only if it changed. */
const SAVE_INTERVAL_SECONDS = 10;
/** The world is written at least this often even if nothing it noticed changed. */
const WORLD_MAX_AGE_SECONDS = 60;

/**
 * Writes the game to a {@link SaveStore}: on a timer, and when the tab is hidden or
 * closed. Writes never overlap (one finishes before the next starts), and a failed
 * write is reported once and retried on the next beat.
 */
export class SaveManager {
  /** For the HUD. */
  status = "starting";

  private elapsed = 0;
  private sinceWorld = 0;
  private lastRevision: string;
  private chain: Promise<void> = Promise.resolve();
  private warned = false;

  private readonly onHide = (): void => {
    if (document.visibilityState === "hidden") this.save(true);
  };
  private readonly onPageHide = (): void => this.save(true);

  constructor(
    private readonly store: SaveStore,
    private readonly sources: SaveSources,
  ) {
    // What was just loaded is already saved.
    this.lastRevision = sources.worldRevision();
    document.addEventListener("visibilitychange", this.onHide);
    window.addEventListener("pagehide", this.onPageHide);
    this.status = "on";
  }

  /** Call once per frame with the frame's real seconds. */
  update(dt: number): void {
    this.elapsed += dt;
    this.sinceWorld += dt;
    if (this.elapsed < SAVE_INTERVAL_SECONDS) return;
    this.elapsed = 0;
    this.save(false);
  }

  /** Writes now. `force` writes the world even if it looks unchanged. */
  save(force: boolean): void {
    const player = this.sources.capturePlayer();
    const revision = this.sources.worldRevision();
    const writeWorld = force || revision !== this.lastRevision || this.sinceWorld >= WORLD_MAX_AGE_SECONDS;

    // Captured now, written when the previous write is done: what is saved is
    // the game at this moment, not at whenever the queue got to it.
    const world = writeWorld ? this.sources.captureWorld() : undefined;
    if (writeWorld) {
      this.lastRevision = revision;
      this.sinceWorld = 0;
    }

    // The player is written straight away, not queued behind a slow world write:
    // when the tab is closing, the synchronous write is the one that lands.
    this.store.savePlayer(player).then(this.saved, this.failed);
    if (world === undefined) return;
    this.chain = this.chain
      .then(() => this.store.saveWorld(world))
      .then(this.saved, (err: unknown) => {
        // Try the world again next beat.
        this.lastRevision = "";
        this.failed(err);
      });
  }

  private readonly saved = (): void => {
    this.status = `saved ${new Date().toLocaleTimeString()}`;
    this.warned = false;
  };

  private readonly failed = (err: unknown): void => {
    this.status = "FAILED";
    if (!this.warned) console.warn("[save] could not write the save; will keep trying", err);
    this.warned = true;
  };

  dispose(): void {
    document.removeEventListener("visibilitychange", this.onHide);
    window.removeEventListener("pagehide", this.onPageHide);
  }
}
