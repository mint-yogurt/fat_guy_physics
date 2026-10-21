import { describe, expect, it } from "vitest";

import { VOXEL_SIZE } from "./constants.ts";
import { MoundList, moundHeight, moundReach } from "./mound.ts";
import { SceneSolidQuery } from "./sceneQuery.ts";

const open = { isSolid: () => false };

function list(x: number, y: number, z: number, scale: number, yaw: number): MoundList {
  const mounds = new MoundList();
  mounds.add(x, y, z, scale, yaw);
  return mounds;
}

describe("snowbank mound", () => {
  it("rises to about the mesh's height and is nothing past its edge", () => {
    const mounds = list(10, 2, 5, 1, 0);
    const mound = mounds.items[0];
    if (mound === undefined) throw new Error("no mound");
    // The unscaled mesh peaks at 1.63, at (1.85, 0.72) in its own frame.
    expect(moundHeight(mound, 10 + 1.847, 5 + 0.724)).toBeCloseTo(1.633, 2);
    expect(moundHeight(mound, 10 + moundReach(1) + 0.1, 5)).toBe(-1);
    expect(moundHeight(mound, 10 + 3.3, 5 + 1.5)).toBe(-1);
  });

  it("scales with the prop, and turns with it", () => {
    const small = list(0, 0, 0, 0.5, 0).items[0];
    const turned = list(0, 0, 0, 0.5, Math.PI / 2).items[0];
    if (small === undefined || turned === undefined) throw new Error("no mound");
    expect(moundHeight(small, 0.9235, 0.362)).toBeCloseTo(0.8165, 2);
    // A quarter turn about Y takes mesh (x, z) to world (z, -x).
    expect(moundHeight(turned, 0.362, -0.9235)).toBeCloseTo(0.8165, 2);
  });

  it("is solid up to its surface, filled in below, and open above, through the scene query", () => {
    const scene = new SceneSolidQuery(open);
    expect(scene.isSolid(100, 20, 50)).toBe(false);
    scene.mounds.add(10, 2, 5, 1, 0);
    const vx = Math.floor((10 + 1.847) / VOXEL_SIZE);
    const vz = Math.floor((5 + 0.724) / VOXEL_SIZE);
    const voxelAt = (metres: number): number => Math.floor(metres / VOXEL_SIZE);
    expect(scene.isSolid(vx, voxelAt(2 + 0.5), vz)).toBe(true);
    expect(scene.isSolid(vx, voxelAt(2 + 1.5), vz)).toBe(true);
    expect(scene.isSolid(vx, voxelAt(2 + 1.8), vz)).toBe(false);
    expect(scene.isSolid(vx, voxelAt(2 - 1), vz)).toBe(true);
    expect(scene.isSolid(vx, voxelAt(2 - 3), vz)).toBe(false);
    expect(scene.isSolid(voxelAt(30), voxelAt(2.5), vz)).toBe(false);
  });

  it("is not added twice", () => {
    const mounds = new MoundList();
    mounds.add(1, 0, 1, 1, 0);
    mounds.add(1, 0, 1, 1, 0);
    mounds.add(8, 0, 1, 1, 0);
    expect(mounds.count).toBe(2);
    mounds.clear();
    expect(mounds.count).toBe(0);
  });
});
