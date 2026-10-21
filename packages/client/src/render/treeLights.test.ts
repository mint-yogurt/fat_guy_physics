import { describe, expect, it } from "vitest";

import type { Tree } from "@fgp/shared/sim/world";

import { canopyRadius, treeStringPath } from "./treeLights.ts";

const tree = { id: 12345, x: 10, y: 2, z: -4, scale: 0.56 } as Tree;

describe("canopyRadius", () => {
  it("is the trunk's width at the top, the skirt's at the bottom, and tapers between", () => {
    expect(canopyRadius(0.75)).toBeGreaterThan(3.3);
    expect(canopyRadius(1.7)).toBeLessThan(canopyRadius(0.75));
    expect(canopyRadius(9)).toBeLessThan(0.3);
  });
});

describe("treeStringPath", () => {
  it("winds round the trunk at canopy height, a segment's length at a time", () => {
    for (let i = 0; i < 3; i++) {
      const path = treeStringPath(tree, i, 3);
      expect(path).toHaveLength(10);
      for (const p of path) {
        const out = Math.hypot(p.x - tree.x, p.z - tree.z);
        expect(out).toBeGreaterThan(0.1);
        // Never further out than the foliage's widest.
        expect(out).toBeLessThan(3.64 * tree.scale);
        expect(p.y).toBeGreaterThan(tree.y + 0.5);
        expect(p.y).toBeLessThan(tree.y + 5.5);
      }
      for (let k = 1; k < path.length; k++) {
        const d = path[k]?.distanceTo(path[k - 1] ?? path[k]!) ?? 0;
        expect(d).toBeGreaterThan(0.1);
        expect(d).toBeLessThan(0.4);
      }
    }
  });
});
