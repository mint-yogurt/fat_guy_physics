import { describe, expect, it } from "vitest";

import {
  boxPushOut,
  elasticForce,
  HARDENING,
  spherePushOut,
  type ElasticMaterial,
  type ElasticVec,
} from "./elastic.ts";

const rubber: ElasticMaterial = { stiffness: 1000, maxStrain: 0.5, maxForce: 5000 };

describe("elasticForce", () => {
  it("only pulls: nothing when it is not stretched", () => {
    expect(elasticForce(rubber, 2, 0)).toBe(0);
    expect(elasticForce(rubber, 2, -0.5)).toBe(0);
  });

  it("is a spring up to its max strain", () => {
    expect(elasticForce(rubber, 2, 0.1)).toBeCloseTo(100, 9);
    expect(elasticForce(rubber, 2, 0.5)).toBeCloseTo(500, 9);
    expect(elasticForce(rubber, 2, 1)).toBeCloseTo(1000, 9); // 50% of 2m
  });

  it("goes hard past it", () => {
    const at = elasticForce(rubber, 2, 1);
    const past = elasticForce(rubber, 2, 1.1);
    expect(past - at).toBeCloseTo(1000 * HARDENING * 0.1, 6);
    expect(past).toBeGreaterThan(elasticForce(rubber, 2, 1.0999) - 1e-6);
  });

  it("scales with the length: the same strain is more stretch in a longer piece", () => {
    expect(elasticForce(rubber, 4, 2)).toBeCloseTo(2000, 9);
  });
});

describe("boxPushOut", () => {
  const out: ElasticVec = { x: 0, y: 0, z: 0 };
  const box = (x: number, y: number, z: number, r = 0.1): boolean =>
    boxPushOut(-1, 0, -1, 1, 2, 1, x, y, z, r, out);

  it("misses what is outside", () => {
    expect(box(1.2, 1, 0)).toBe(false);
    expect(box(0, 2.2, 0)).toBe(false);
    expect(box(0, -0.2, 0)).toBe(false);
  });

  it("sends a particle out of the nearest side, clear of it by its radius", () => {
    expect(box(0.8, 1, 0)).toBe(true);
    expect(out.x).toBeCloseTo(0.3, 9);
    expect(out.y).toBe(0);
    expect(box(0, 1, -0.9)).toBe(true);
    expect(out.x).toBe(0);
    expect(out.z).toBeCloseTo(-0.2, 9);
  });

  it("goes over the top only when nearly through it, never out of the bottom", () => {
    expect(box(0, 1.95, 0)).toBe(true);
    expect(out.y).toBeCloseTo(0.15, 9);
    expect(out.x).toBe(0);
    expect(box(0.2, 1, 0.2)).toBe(true);
    expect(out.y).toBe(0);
    expect(box(0.95, 0.05, 0)).toBe(true);
    expect(out.y).toBe(0);
  });
});

describe("spherePushOut", () => {
  const out: ElasticVec = { x: 0, y: 0, z: 0 };

  it("sends a particle straight out from the middle", () => {
    expect(spherePushOut(0, 1, 0, 1, 0.5, 1, 0, 0.1, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.6, 9);
    expect(out.y).toBeCloseTo(0, 9);
    expect(spherePushOut(0, 1, 0, 1, 2, 1, 0, 0.1, out)).toBe(false);
  });

  it("sends one under the middle out along the ground, not down into it", () => {
    expect(spherePushOut(0, 1, 0, 1, 0.3, 0.1, 0, 0.1, out)).toBe(true);
    expect(out.y).toBe(0);
    expect(Math.hypot(0.3 + out.x, 0.9)).toBeCloseTo(1.1, 9);
  });
});
