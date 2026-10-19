import { describe, expect, it } from "vitest";
import { BoxGeometry, PlaneGeometry, SphereGeometry } from "three/webgpu";

import { faceOutward, facesInward, reverseWinding } from "./meshOrientation.ts";

/**
 * What matters here is the judgement call, not the flip: flipping a mesh
 * that was fine is as visible a bug as leaving a flipped one alone, and the
 * assets contain open meshes whose enclosed volume is meaningless. So these
 * check both directions on solid meshes, and that a flat one is left alone
 * whichever way round it is wound.
 */

describe("facesInward", () => {
  it("passes a mesh wound the right way round", () => {
    expect(facesInward(new BoxGeometry(2, 4, 2))).toBe(false);
    expect(facesInward(new SphereGeometry(1, 12, 8))).toBe(false);
  });

  it("catches a mesh wound inside out", () => {
    const box = new BoxGeometry(2, 4, 2);
    reverseWinding(box);
    expect(facesInward(box)).toBe(true);
  });

  it("catches it whether or not the mesh is indexed", () => {
    const box = new BoxGeometry(2, 4, 2).toNonIndexed();
    expect(facesInward(box)).toBe(false);
    reverseWinding(box);
    expect(facesInward(box)).toBe(true);
  });

  it("leaves an open mesh alone, wound either way", () => {
    const plane = new PlaneGeometry(2, 2);
    expect(facesInward(plane)).toBe(false);
    reverseWinding(plane);
    expect(facesInward(plane)).toBe(false);
  });

  // A mesh the size of a far-off tree is the same shape as a small one.
  it("judges a mesh the same at any scale", () => {
    const small = new BoxGeometry(0.1, 0.2, 0.1);
    const large = new BoxGeometry(10, 20, 10);
    reverseWinding(small);
    reverseWinding(large);
    expect(facesInward(small)).toBe(true);
    expect(facesInward(large)).toBe(true);
  });
});

describe("reverseWinding", () => {
  it("turns the normals round with the triangles", () => {
    const box = new BoxGeometry(1, 1, 1);
    const before = Array.from(box.getAttribute("normal").array as Float32Array);
    reverseWinding(box);
    const after = Array.from(box.getAttribute("normal").array as Float32Array);
    expect(after).toEqual(before.map((n) => -n));
  });

  // Reordering a non-indexed mesh's corners has to carry every attribute
  // with it, or the texture ends up shuffled across the triangle.
  it("keeps each corner's own uv attached to it", () => {
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    const corners = (): string[] => {
      const position = box.getAttribute("position");
      const uv = box.getAttribute("uv");
      const out: string[] = [];
      for (let i = 0; i < position.count; i++) {
        out.push(
          `${position.getX(i)},${position.getY(i)},${position.getZ(i)}:${uv.getX(i)},${uv.getY(i)}`,
        );
      }
      return out.sort();
    };

    const before = corners();
    reverseWinding(box);
    expect(corners()).toEqual(before);
  });
});

describe("faceOutward", () => {
  it("rights an inside-out mesh and leaves a good one untouched", () => {
    const flipped = new BoxGeometry(1, 2, 1);
    reverseWinding(flipped);
    expect(facesInward(faceOutward(flipped))).toBe(false);

    const good = new BoxGeometry(1, 2, 1);
    const normals = Array.from(good.getAttribute("normal").array as Float32Array);
    faceOutward(good);
    expect(Array.from(good.getAttribute("normal").array as Float32Array)).toEqual(normals);
  });
});
