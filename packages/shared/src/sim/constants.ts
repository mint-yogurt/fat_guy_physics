/**
 * Simulation constants shared by the client and the (future) authoritative
 * server.
 *
 * These live in exactly one place on purpose. The netcode design has the
 * server re-deriving a client frame's substep count from the frame's reported
 * dt using the *same* clamp and cap -- so if these values are ever duplicated
 * and the copies drift, the server stops being able to reproduce client
 * motion exactly and reconciliation degrades into permanent low-grade jitter.
 *
 * Ported from src/voxel/Voxel.hpp and src/main.cpp.
 */

/** ~10cm per voxel. See DESIGN.md "Deformable terrain". */
export const VOXEL_SIZE = 0.1;

/** Voxels per chunk edge; a chunk is a 3.2m cube. */
export const CHUNK_SIZE = 32;

/** Voxels per chunk. Precomputed -- indexing hot loops should not cube this. */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE;

/**
 * Fixed simulation step. At 0.1m voxels, integrating a raw frame delta in one
 * step tunnels the player through terrain, hence the fixed substep loop rather
 * than variable-dt integration (src/main.cpp:154-156).
 */
export const FIXED_TIMESTEP = 1 / 120;

/**
 * A frame longer than this is clamped *before* being accumulated, so a long
 * stall (alt-tab, a GC pause, a breakpoint) doesn't dump a huge backlog of
 * substeps into the next frame.
 */
export const MAX_FRAME_TIME = 0.1;

/**
 * Substeps per frame ceiling. On hitting it the accumulator is zeroed rather
 * than carried: time is deliberately dropped so a slow frame can't spiral into
 * progressively slower frames.
 */
export const MAX_SUBSTEPS = 8;
