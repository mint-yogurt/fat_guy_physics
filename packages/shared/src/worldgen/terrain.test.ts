import { describe, expect, it } from "vitest";

import golden from "../../../../tools/golden/golden.json" with { type: "json" };
import { TerrainGenerator } from "./terrainGenerator.ts";

/**
 * The terrain's height field against the C++ reference build (the `biomes = false` path). The
 * voxel contents and the greedy mesher the reference also recorded belong to the old voxel
 * ground, which is gone; only the height function lives on.
 */
describe("TerrainGenerator", () => {
  const gen = new TerrainGenerator(golden.seed, false);

  it("matches the C++ surface height, including at negative coordinates", () => {
    const mismatches: string[] = [];
    for (const { x, z, h } of golden.surfaceHeight) {
      const actual = gen.surfaceHeight(x, z);
      if (actual !== h) mismatches.push(`surfaceHeight(${x}, ${z}) = ${actual}, expected ${h}`);
    }
    expect(mismatches).toEqual([]);
  });
});
