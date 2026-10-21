import { describe, expect, it } from "vitest";

import { NearestLights } from "./bulbLights.ts";

describe("NearestLights", () => {
  it("keeps the nearest few in order, and ignores those out of range", () => {
    const lights = new NearestLights(3, 10);
    lights.begin(0, 0, 0);
    for (const x of [5, 1, 20, 4, 2, 3, -0.5]) lights.offer(x, 0, 0, x, 0, 0);
    expect(lights.count).toBe(3);
    expect(Array.from({ length: 3 }, (_, i) => lights.data[i * 6])).toEqual([-0.5, 1, 2]);
    // The colour travels with its position.
    expect(lights.data[1 * 6 + 3]).toBe(1);

    lights.begin(0, 0, 0);
    lights.offer(50, 0, 0, 1, 1, 1);
    expect(lights.count).toBe(0);
  });
});
