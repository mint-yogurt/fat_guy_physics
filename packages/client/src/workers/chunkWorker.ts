/// <reference lib="webworker" />

import { buildChunk } from "@fgp/shared/sim/chunkSource";
import { Mesher } from "@fgp/shared/voxel/greedyMesher";
import { TerrainGenerator } from "@fgp/shared/worldgen/terrainGenerator";

/**
 * Generates and meshes chunks off the main thread. Replaces World::workerLoop
 * from the C++, which was a std::thread over the same work.
 *
 * The one structural difference from the C++ pool: those threads shared a
 * single TerrainGenerator because it is immutable after construction. Workers
 * share nothing, so each one builds its own generator and its own mesher.
 * That is fine -- a generator is a noise object, and a mesher is a scratch
 * buffer that *should* be per-thread anyway -- but it does mean the seed has
 * to be sent before any work, hence the init message.
 *
 * Notably absent: SharedArrayBuffer. Using it would require the page to be
 * served with COOP/COEP headers, which would make the build undeployable as
 * plain static files. Transferables give us zero-copy handoff without that
 * constraint; the only thing we give up is sharing the voxel grid in place,
 * which nothing needs.
 */

export interface ChunkWorkerInit {
  type: "init";
  seed: number;
}

export interface ChunkWorkerJob {
  type: "job";
  key: number;
  cx: number;
  cy: number;
  cz: number;
}

export type ChunkWorkerRequest = ChunkWorkerInit | ChunkWorkerJob;

export interface ChunkWorkerDone {
  key: number;
  cx: number;
  cy: number;
  cz: number;
  cells: Uint8Array;
  vertices: Float32Array;
  vertexCount: number;
}

const scope = self as unknown as DedicatedWorkerGlobalScope;

let generator: TerrainGenerator | undefined;
const mesher = new Mesher();

scope.onmessage = (event: MessageEvent<ChunkWorkerRequest>): void => {
  const message = event.data;

  if (message.type === "init") {
    generator = new TerrainGenerator(message.seed);
    return;
  }

  if (generator === undefined) {
    // The pool always sends init before any job, so this is a programming
    // error rather than a race worth recovering from -- fail loudly instead
    // of silently generating a differently-seeded world.
    throw new Error("chunk worker received a job before init");
  }

  const result = buildChunk(generator, mesher, message.key, message.cx, message.cy, message.cz);

  // Transfer rather than copy. Both buffers are freshly allocated per chunk
  // and the worker has no further use for them, so handing over ownership is
  // free; structured-cloning them instead would mean memcpy-ing ~45KB per
  // chunk, ~20MB over a full initial load.
  scope.postMessage(result satisfies ChunkWorkerDone, [
    result.cells.buffer,
    result.vertices.buffer,
  ]);
};
