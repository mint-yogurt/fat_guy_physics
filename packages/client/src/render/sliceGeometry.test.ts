import { describe, expect, it } from "vitest";
import { BoxGeometry, CylinderGeometry } from "three/webgpu";

import { sliceAtY } from "./sliceGeometry.ts";

/**
 * The slicer is the one piece of real geometry code in the tree work, and
 * the cut it makes is invisible from the outside -- a trunk cut at the
 * wrong height still looks like a trunk. So these check the two things a
 * cut has to be right about: neither half crosses the plane, and together
 * they still hold the whole mesh.
 */

function yRange(geometry: { getAttribute: (name: string) => unknown }): [number, number] {
  const position = geometry.getAttribute("position") as { array: ArrayLike<number>; count: number };
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    const y = position.array[i * 3 + 1] ?? 0;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  return [min, max];
}

function triangleCount(geometry: { getAttribute: (name: string) => unknown }): number {
  const position = geometry.getAttribute("position") as { count: number };
  return position.count / 3;
}

describe("sliceAtY", () => {
  it("splits a box into halves that meet at the plane", () => {
    const box = new BoxGeometry(2, 4, 2).toNonIndexed();
    const { below, above } = sliceAtY(box, 1);

    expect(below).toBeDefined();
    expect(above).toBeDefined();
    if (below === undefined || above === undefined) return;

    // Each half stops exactly at the cut, within float noise.
    const [belowMin, belowMax] = yRange(below);
    const [aboveMin, aboveMax] = yRange(above);
    expect(belowMin).toBeCloseTo(-2);
    expect(belowMax).toBeCloseTo(1);
    expect(aboveMin).toBeCloseTo(1);
    expect(aboveMax).toBeCloseTo(2);

    // Nothing is lost: a box is 12 triangles, and cutting across four of
    // its sides turns each of those into three.
    expect(triangleCount(below) + triangleCount(above)).toBeGreaterThanOrEqual(12);
  });

  it("gives the whole mesh to one side when the plane misses it", () => {
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();

    const high = sliceAtY(box, 5);
    expect(high.below).toBeDefined();
    expect(high.above).toBeUndefined();

    const low = sliceAtY(box, -5);
    expect(low.below).toBeUndefined();
    expect(low.above).toBeDefined();
  });

  it("keeps a trunk's radius at the cut", () => {
    // A tapered cylinder, which is what every trunk in the game is: the cut
    // face has to be the width the trunk is at that height, not the width
    // at either end.
    const trunk = new CylinderGeometry(0.5, 1.5, 4, 12).toNonIndexed();
    const { above } = sliceAtY(trunk, 0);
    expect(above).toBeDefined();
    if (above === undefined) return;

    const position = above.getAttribute("position");
    let maxRadiusAtCut = 0;
    for (let i = 0; i < position.count; i++) {
      const x = position.array[i * 3] ?? 0;
      const y = position.array[i * 3 + 1] ?? 0;
      const z = position.array[i * 3 + 2] ?? 0;
      if (Math.abs(y) > 1e-4) continue;
      maxRadiusAtCut = Math.max(maxRadiusAtCut, Math.hypot(x, z));
    }
    // Halfway up a 0.5-to-1.5 taper. The polygon's flats sit inside the
    // true radius, hence the tolerance rather than an exact 1.
    expect(maxRadiusAtCut).toBeGreaterThan(0.9);
    expect(maxRadiusAtCut).toBeLessThanOrEqual(1.001);
  });
});
