/**
 * Deterministic integer hashing.
 *
 * Ported from the FNV-1a-style mixer in src/voxel/Vegetation.cpp. It only
 * needs to be well-distributed, not cryptographic -- placement and shape
 * should read as scattered rather than gridded.
 *
 * ## Why Math.imul is not optional
 *
 * The C++ is `h *= 0x01000193u` on a uint32, which wraps. The naive JS
 * translation `h = h * 0x01000193` evaluates as a double: the product of two
 * 32-bit values needs up to 64 bits of mantissa, a double has 53, and the
 * *low* bits -- the ones the subsequent xor-shift folds back in -- are
 * exactly the ones silently lost. Math.imul performs the real C-style 32-bit
 * multiply.
 *
 * The failure mode is nasty specifically because it is not a crash. Every
 * tree, bush and jittered placement in the world simply moves somewhere else,
 * deterministically and plausibly. The world still generates, still looks
 * like a world, and is wrong forever -- and once there is a server, client
 * and server disagree about where everything is. Hence hash.test.ts, which
 * asserts against values dumped from the C++ build.
 *
 * `>>> 0` after each step keeps the value an unsigned 32-bit integer rather
 * than letting it drift negative through the xor, which matters because the
 * final shift in hashFloat is an unsigned one.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hash32(a: number, b: number, c: number, d: number): number {
  let h = FNV_OFFSET_BASIS >>> 0;

  // Inlined rather than a closure: this is called ~25 times per vegetation
  // candidate cell during worker-thread generation, and a per-call closure
  // allocation is exactly the kind of steady-state garbage the port is
  // trying not to reintroduce.
  h = (h ^ (a >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;

  h = (h ^ (b >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;

  h = (h ^ (c >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;

  h = (h ^ (d >>> 0)) >>> 0;
  h = Math.imul(h, FNV_PRIME) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;

  return h >>> 0;
}

/**
 * [0, 1) from a hash, using the top 24 bits for a clean float mantissa.
 * Matches hashFloat in src/voxel/Vegetation.cpp.
 */
export function hashFloat(a: number, b: number, c: number, d: number): number {
  return (hash32(a, b, c, d) >>> 8) * (1 / 16777216);
}

/** Linear interpolation. Matches the file-local lerp in Vegetation.cpp. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
