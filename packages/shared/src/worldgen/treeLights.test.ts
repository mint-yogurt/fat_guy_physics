import { describe, expect, it } from "vitest";

import { treeLightCount, TREE_LIGHTS_MAX } from "./trees.ts";
import { treeHashAt } from "./trees.ts";

describe("treeLightCount", () => {
  it("strings about one tree in four with one to three sets, the same every time", () => {
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i++) {
      const count = treeLightCount(treeHashAt(i * 7, i * 13, 99));
      expect(count).toBe(treeLightCount(treeHashAt(i * 7, i * 13, 99)));
      expect(count).toBeLessThanOrEqual(TREE_LIGHTS_MAX);
      counts[count] = (counts[count] ?? 0) + 1;
    }
    const lit = 4000 - (counts[0] ?? 0);
    expect(lit / 4000).toBeGreaterThan(0.21);
    expect(lit / 4000).toBeLessThan(0.29);
    for (const n of [1, 2, 3]) expect(counts[n]).toBeGreaterThan(lit / 5);
  });
});
