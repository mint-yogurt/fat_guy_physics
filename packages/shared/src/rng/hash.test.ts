import { describe, expect, it } from "vitest";

import golden from "../../../../tools/golden/golden.json" with { type: "json" };
import { hash32, hashFloat } from "./hash.ts";

/**
 * The first test in the repo, and deliberately so.
 *
 * `h *= 0x01000193u` wraps in C++; the naive JS translation `h * 0x01000193`
 * is a double multiply that silently discards the low bits the subsequent
 * xor-shift folds back in. Nothing crashes. The world still generates and
 * still looks like a world -- every tree, bush and jittered placement in it
 * is just somewhere else than the reference build puts it, forever. And once
 * there is a server, client and server disagree about where everything is.
 *
 * Reference values come from the real C++ via tools/golden/dump-golden.sh,
 * which extracts hash32/hashFloat straight out of Vegetation.cpp rather than
 * copying them, so this cannot pass against a drifted copy of the function.
 */
describe("hash32", () => {
  it("matches the C++ reference for every golden tuple", () => {
    expect(golden.hash.length).toBeGreaterThan(100);

    const mismatches: string[] = [];
    for (const { a, b, c, d, h } of golden.hash) {
      const actual = hash32(a, b, c, d);
      if (actual !== h) {
        mismatches.push(`hash32(${a}, ${b}, ${c}, ${d}) = ${actual}, expected ${h}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("returns an unsigned 32-bit integer", () => {
    for (const { a, b, c, d } of golden.hash) {
      const h = hash32(a, b, c, d);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it("would catch the double-multiply bug", () => {
    // The exact mistake this suite exists to prevent, as an explicit
    // regression guard: if someone "simplifies" Math.imul away, the naive
    // version must not agree with the reference.
    const naive = (a: number, b: number, c: number, d: number): number => {
      let h = 0x811c9dc5 >>> 0;
      for (const v of [a, b, c, d]) {
        h = (h ^ (v >>> 0)) >>> 0;
        h = (h * 0x01000193) >>> 0; // the bug: double multiply, not Math.imul
        h = (h ^ (h >>> 15)) >>> 0;
      }
      return h >>> 0;
    };
    const differs = golden.hash.some(({ a, b, c, d, h }) => naive(a, b, c, d) !== h);
    expect(differs).toBe(true);
  });
});

describe("hashFloat", () => {
  it("matches the C++ reference", () => {
    for (const { a, b, c, d, f } of golden.hash) {
      // The C++ computes in float32 and the JSON carries it at full float32
      // precision; the TS value is a double. They agree far more tightly
      // than this, but an exact compare would be asserting on float width
      // rather than on correctness.
      expect(hashFloat(a, b, c, d)).toBeCloseTo(f, 6);
    }
  });

  it("stays within [0, 1)", () => {
    for (const { a, b, c, d } of golden.hash) {
      const v = hashFloat(a, b, c, d);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
