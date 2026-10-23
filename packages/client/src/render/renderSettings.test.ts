import { describe, expect, it } from "vitest";
import { bayer4, quantize5 } from "./n64Dither.ts";
import { internalSize, pictureFill, resolveSettings, viewAspect } from "./renderSettings.ts";

describe("render settings", () => {
  it("defaults to 240p filling the window", () => {
    expect(resolveSettings("", null)).toEqual({ internalHeight: 240, aspect: "window" });
  });

  it("takes URL flags over stored values", () => {
    const stored = JSON.stringify({ internalHeight: 240, aspect: "16:9" });
    expect(resolveSettings("?res=480&aspect=4:3", stored)).toEqual({ internalHeight: 480, aspect: "4:3" });
    expect(resolveSettings("", stored)).toEqual({ internalHeight: 240, aspect: "16:9" });
  });

  it("snaps odd heights and ignores junk", () => {
    expect(resolveSettings("?res=400", null).internalHeight).toBe(480);
    expect(resolveSettings("?res=abc&aspect=wide", "not json")).toEqual({ internalHeight: 240, aspect: "window" });
  });

  it("sizes the picture from its aspect", () => {
    expect(internalSize(240, viewAspect("4:3", 2))).toEqual({ width: 320, height: 240 });
    expect(internalSize(240, viewAspect("16:9", 1.5)).width).toBe(427);
    expect(viewAspect("window", 2.4)).toBe(2.4);
  });

  it("leaves bars when the shapes differ", () => {
    expect(pictureFill(4 / 3, 16 / 9)).toEqual({ x: 0.75, y: 1 });
    expect(pictureFill(16 / 9, 4 / 3)).toEqual({ x: 1, y: 0.75 });
    expect(pictureFill(1.5, 1.5)).toEqual({ x: 1, y: 1 });
  });
});

describe("n64 dither", () => {
  it("uses every entry of the 4x4 Bayer matrix once", () => {
    const seen = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) seen.add(bayer4(x, y));
    expect([...seen].sort((a, b) => a - b)).toEqual([...Array(16).keys()]);
  });

  it("keeps black and white and only ever lands on 5-bit levels", () => {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(quantize5(0, x, y)).toBe(0);
        expect(quantize5(1, x, y)).toBe(1);
        const level = quantize5(0.37, x, y) * 31;
        expect(Math.abs(level - Math.round(level))).toBeLessThan(1e-9);
      }
    }
  });

  it("averages back to the input over a cell", () => {
    let sum = 0;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) sum += quantize5(0.37, x, y);
    expect(sum / 16).toBeCloseTo(0.37, 1);
  });
});
