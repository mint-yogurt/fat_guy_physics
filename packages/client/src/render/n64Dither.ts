/**
 * The N64 drew with 8 bits per channel but stored 5, hiding the banding with an ordered dither.
 * This is the plain-TypeScript statement of that maths; `n64Pass.ts` repeats it in TSL, and the
 * test pins the two to the same numbers.
 */

export const LEVELS = 31;

/** 2x2 Bayer cell, 0..3: [[0,2],[3,1]]. */
function bayer2(x: number, y: number): number {
  return 2 * ((x ^ y) & 1) + (y & 1);
}

/** 4x4 Bayer matrix entry for a pixel, 0..15. */
export function bayer4(x: number, y: number): number {
  const px = x & 3;
  const py = y & 3;
  return 4 * bayer2(px & 1, py & 1) + bayer2(px >> 1, py >> 1);
}

/** A channel value in 0..1 cut to 5 bits at pixel (x, y), with the dither added first. */
export function quantize5(value: number, x: number, y: number): number {
  const threshold = (bayer4(x, y) + 0.5) / 16;
  return Math.floor(value * LEVELS + threshold) / LEVELS;
}
