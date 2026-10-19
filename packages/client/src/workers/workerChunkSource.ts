import type { ChunkResult, ChunkSource } from "@fgp/shared/sim/chunkSource";

import type { ChunkWorkerDone, ChunkWorkerRequest } from "./chunkWorker.ts";

/**
 * A pool of chunk-generating Web Workers. Replaces the C++ World's
 * std::thread pool (World::submitJob / workerLoop / the job + result deques).
 *
 * Results land in a plain array as they arrive and are drained by World on
 * its own schedule, which is the same shape as the C++ result queue and for
 * the same reason: a worker finishing is not a good moment to do GPU work.
 */

/**
 * One worker is left for the main thread, which has to render, upload
 * geometry and run the game loop -- saturating every core just makes the
 * frame that has to consume the results slower. Capped at 8 because chunk
 * generation stops being the bottleneck well before that and each worker
 * costs its own module instantiation and heap.
 */
function defaultWorkerCount(): number {
  const cores = navigator.hardwareConcurrency;
  const usable = typeof cores === "number" && cores > 0 ? cores - 1 : 3;
  return Math.max(1, Math.min(8, usable));
}

export class WorkerChunkSource implements ChunkSource {
  private readonly workers: Worker[] = [];
  private readonly ready: ChunkResult[] = [];

  /**
   * Jobs that have not been handed to a worker yet.
   *
   * Dealing every job out immediately would work, but a worker that is
   * handed ten chunks at once cannot give the last one back early if the
   * player turns around. Keeping the backlog here and topping each worker up
   * to a small depth keeps jobs cancellable-in-practice and keeps the
   * nearest-first order World submitted them in actually meaningful.
   */
  private readonly backlog: ChunkWorkerRequest[] = [];
  private readonly outstanding: number[];

  /**
   * Jobs in flight per worker. Low, but not 1: at 1 a worker idles for a
   * full message round-trip between chunks, which at ~1.5ms of real work per
   * chunk is a large fraction of its time.
   */
  private static readonly DEPTH = 3;

  private pendingCount = 0;
  private disposed = false;

  constructor(seed: number, workerCount = defaultWorkerCount()) {
    this.outstanding = new Array<number>(workerCount).fill(0);

    for (let i = 0; i < workerCount; i++) {
      // `new URL(..., import.meta.url)` is the form Vite statically
      // analyses; a string path would not be bundled for production.
      const worker = new Worker(new URL("./chunkWorker.ts", import.meta.url), {
        type: "module",
        name: `chunk-worker-${String(i)}`,
      });
      const index = i;
      worker.onmessage = (event: MessageEvent<ChunkWorkerDone>): void => {
        this.outstanding[index] = (this.outstanding[index] ?? 1) - 1;
        this.pendingCount--;
        this.ready.push(event.data);
        this.pump();
      };
      worker.onerror = (event: ErrorEvent): void => {
        // A worker that dies silently looks exactly like terrain that
        // stopped streaming, which is a miserable thing to debug.
        console.error(`chunk worker ${String(index)} failed`, event.message);
      };
      worker.postMessage({ type: "init", seed } satisfies ChunkWorkerRequest);
      this.workers.push(worker);
    }
  }

  get pending(): number {
    return this.pendingCount;
  }

  get workerCount(): number {
    return this.workers.length;
  }

  submit(key: number, cx: number, cy: number, cz: number): void {
    if (this.disposed) return;
    this.backlog.push({ type: "job", key, cx, cy, cz });
    this.pendingCount++;
    this.pump();
  }

  /** Tops up any worker below DEPTH from the backlog, nearest-first. */
  private pump(): void {
    for (let i = 0; i < this.workers.length && this.backlog.length > 0; i++) {
      while ((this.outstanding[i] ?? 0) < WorkerChunkSource.DEPTH && this.backlog.length > 0) {
        const job = this.backlog.shift();
        if (job === undefined) return;
        this.outstanding[i] = (this.outstanding[i] ?? 0) + 1;
        this.workers[i]?.postMessage(job);
      }
    }
  }

  poll(): ChunkResult | undefined {
    return this.ready.shift();
  }

  dispose(): void {
    this.disposed = true;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
    this.backlog.length = 0;
    this.ready.length = 0;
    this.pendingCount = 0;
  }
}
