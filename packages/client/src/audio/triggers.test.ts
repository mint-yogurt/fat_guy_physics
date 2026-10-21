import { describe, expect, it } from "vitest";

import {
  AmbienceScheduler,
  LAND_FULL_SPEED,
  LAND_MIN_SPEED,
  landingGain,
  RisingEdge,
  STRIDE_METERS,
  StrideTracker,
} from "./triggers.ts";

describe("StrideTracker", () => {
  it("steps once per stride walked, alternating feet", () => {
    const stride = new StrideTracker();
    let steps = 0;
    const feet: number[] = [];
    // 10 m at 5 m/s in 1/60 s frames, from a standing start of zero walked.
    for (let i = 0; i < 120; i++) {
      if (stride.update(1 / 60, 5)) {
        steps++;
        feet.push(stride.foot);
      }
    }
    expect(steps).toBe(Math.floor(10 / STRIDE_METERS));
    expect(feet.slice(0, 4)).toEqual([1, 0, 1, 0]);
  });

  it("is silent standing still or in the air", () => {
    const stride = new StrideTracker();
    for (let i = 0; i < 600; i++) expect(stride.update(1 / 60, 0)).toBe(false);
  });

  it("starts a fresh walk with a step within half a stride", () => {
    const stride = new StrideTracker();
    stride.update(1 / 60, 0);
    let frames = 0;
    while (!stride.update(1 / 60, 3)) frames++;
    expect((frames * 3) / 60).toBeLessThanOrEqual(STRIDE_METERS / 2 + 3 / 60);
  });
});

describe("landingGain", () => {
  it("ignores gentle landings and rises to full", () => {
    expect(landingGain(6)).toBe(0);
    expect(landingGain(LAND_MIN_SPEED - 0.01)).toBe(0);
    const soft = landingGain(LAND_MIN_SPEED);
    const hard = landingGain(LAND_FULL_SPEED);
    expect(soft).toBeGreaterThan(0);
    expect(hard).toBeCloseTo(1);
    expect(landingGain(LAND_FULL_SPEED * 3)).toBeCloseTo(1);
  });
});

describe("RisingEdge", () => {
  it("fires once per rise and re-arms below the low mark", () => {
    const edge = new RisingEdge<object>(0.5, 0.25);
    const rope = {};
    const fired: boolean[] = [];
    for (const v of [0.1, 0.4, 0.6, 0.9, 0.4, 0.3, 0.6, 0.2, 0.7]) fired.push(edge.update(rope, v));
    expect(fired).toEqual([false, false, true, false, false, false, false, false, true]);
  });

  it("tracks each key on its own", () => {
    const edge = new RisingEdge<object>(0.5, 0.25);
    const a = {};
    const b = {};
    expect(edge.update(a, 0.8)).toBe(true);
    expect(edge.update(b, 0.8)).toBe(true);
    expect(edge.update(a, 0.8)).toBe(false);
  });
});

describe("AmbienceScheduler", () => {
  it("only counts down inside the place, then waits again", () => {
    const scheduler = new AmbienceScheduler(10, 20, 0.5, () => 0);
    // Elsewhere for a long time: nothing owed.
    for (let i = 0; i < 100; i++) expect(scheduler.update(1, 0.2)).toBe(false);
    let seconds = 0;
    while (!scheduler.update(1, 0.9)) seconds++;
    expect(seconds).toBe(9); // wait of 10 s fires on the 10th second
    // The next one is another full wait away.
    for (let i = 0; i < 9; i++) expect(scheduler.update(1, 0.9)).toBe(false);
    expect(scheduler.update(1, 0.9)).toBe(true);
  });

  it("draws the wait between min and max", () => {
    const scheduler = new AmbienceScheduler(10, 20, 0.5, () => 1);
    let seconds = 0;
    while (!scheduler.update(1, 1)) seconds++;
    expect(seconds).toBe(19);
  });
});
