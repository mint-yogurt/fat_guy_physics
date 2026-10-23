import { describe, expect, it } from "vitest";

import { VOXEL_SIZE } from "../sim/constants.ts";
import {
  cellHeight,
  createLattice,
  fillLattice,
  GROUND_STEP,
  heightInTile,
  latticeCells,
  LATTICE_SIDE,
  tileOf,
  TILE_CELLS,
  TILE_METERS,
} from "./groundField.ts";
import { buildGroundTile, GROUND_FLOATS_PER_VERTEX } from "./groundMesh.ts";
import { pitFloorAt, pitsNear } from "./gravePits.ts";
import { placeCell, type Placement, type PropPlacement } from "./spawns.ts";
import { TerrainGenerator } from "./terrainGenerator.ts";

const gen = new TerrainGenerator(1337);

describe("ground lattice", () => {
  it("makes a tile exactly the footprint of one old chunk column", () => {
    expect(TILE_METERS).toBeCloseTo(3.2, 12);
    expect(GROUND_STEP).toBeCloseTo(8 * VOXEL_SIZE, 12);
    expect(TILE_CELLS * GROUND_STEP).toBe(TILE_METERS);
  });

  it("finds the tile of a position on the lattice's own integer maths", () => {
    expect(tileOf(0)).toBe(0);
    expect(tileOf(TILE_METERS - 0.001)).toBe(0);
    expect(tileOf(TILE_METERS)).toBe(1);
    expect(tileOf(-0.001)).toBe(-1);
    expect(tileOf(-TILE_METERS)).toBe(-1);
    expect(tileOf(-TILE_METERS - 0.001)).toBe(-2);
  });

  it("agrees between neighbouring tiles along their shared edge", () => {
    for (const [cx, cz] of [[0, 0], [-3, 7], [40, -12]] as const) {
      const a = fillLattice(gen, cx, cz, createLattice());
      const right = fillLattice(gen, cx + 1, cz, createLattice());
      const below = fillLattice(gen, cx, cz + 1, createLattice());
      for (let k = 0; k < LATTICE_SIDE; k++) {
        expect(a[TILE_CELLS + LATTICE_SIDE * k]).toBe(right[LATTICE_SIDE * k]);
        expect(a[k + LATTICE_SIDE * TILE_CELLS]).toBe(below[k]);
      }
    }
  });

  it("reads the same height from a stored tile as straight from the generator", () => {
    const cx = 5;
    const cz = -9;
    const lattice = fillLattice(gen, cx, cz, createLattice());
    for (let i = 0; i < 20; i++) {
      const x = cx * TILE_METERS + ((i * 0.137) % 1) * TILE_METERS * 0.999;
      const z = cz * TILE_METERS + ((i * 0.291) % 1) * TILE_METERS * 0.999;
      expect(heightInTile(lattice, cx, cz, x, z)).toBeCloseTo(gen.groundHeight(x, z), 5);
    }
  });

  it("passes through the lattice vertices and stays between them", () => {
    const lattice = fillLattice(gen, 2, 2, createLattice());
    const x0 = 2 * TILE_METERS;
    const z0 = 2 * TILE_METERS;
    expect(heightInTile(lattice, 2, 2, x0, z0)).toBeCloseTo(lattice[0] as number, 5);
    expect(heightInTile(lattice, 2, 2, x0 + GROUND_STEP, z0)).toBeCloseTo(lattice[1] as number, 4);
    // A cell's four corners bound the ground inside it.
    const h = [1, 4, 2, 7] as const;
    for (const [fx, fz] of [[0.2, 0.7], [0.9, 0.1], [0.5, 0.5]] as const) {
      const v = cellHeight(h[0], h[1], h[2], h[3], fx, fz);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(7);
    }
  });

  it("is smooth where the rounded voxel height was stepped", () => {
    // Along a gentle slope the old integer height changes in whole-voxel steps; the new one
    // does not.
    let distinct = 0;
    let last = Number.NaN;
    for (let x = 0; x < 20; x += 0.05) {
      const h = gen.groundHeight(x, 0.3);
      if (h !== last) distinct++;
      last = h;
    }
    expect(distinct).toBeGreaterThan(200);
  });
});

describe("ground tile mesh", () => {
  const tile = buildGroundTile(gen, 3, -4);

  it("is two triangles a cell, exactly sized", () => {
    expect(tile.vertexCount).toBe(TILE_CELLS * TILE_CELLS * 6);
    expect(tile.vertices.length).toBe(tile.vertexCount * GROUND_FLOATS_PER_VERTEX);
    expect(tile.lattice.length).toBe(LATTICE_SIDE * LATTICE_SIDE);
  });

  it("faces up and lies on the lattice", () => {
    const f = GROUND_FLOATS_PER_VERTEX;
    for (let t = 0; t < tile.vertexCount; t += 3) {
      const p = (c: number, k: number): number => tile.vertices[(t + c) * f + k] as number;
      const ax = p(1, 0) - p(0, 0);
      const az = p(1, 2) - p(0, 2);
      const bx = p(2, 0) - p(0, 0);
      const bz = p(2, 2) - p(0, 2);
      const normalY = az * bx - ax * bz;
      expect(normalY).toBeGreaterThan(0);
    }
    for (let v = 0; v < tile.vertexCount; v++) {
      const x = tile.vertices[v * f] as number;
      const y = tile.vertices[v * f + 1] as number;
      const z = tile.vertices[v * f + 2] as number;
      const i = Math.round(x / GROUND_STEP);
      const j = Math.round(z / GROUND_STEP);
      expect(y).toBe(tile.lattice[i + LATTICE_SIDE * j]);
    }
  });

  it("blends textures that sum to one, with unit normals", () => {
    const f = GROUND_FLOATS_PER_VERTEX;
    for (let v = 0; v < tile.vertexCount; v++) {
      const at = v * f;
      const sum = (tile.vertices[at + 6] as number) + (tile.vertices[at + 7] as number) + (tile.vertices[at + 8] as number);
      expect(sum).toBeCloseTo(1, 5);
      const n = Math.hypot(tile.vertices[at + 3] as number, tile.vertices[at + 4] as number, tile.vertices[at + 5] as number);
      expect(n).toBeCloseTo(1, 5);
    }
  });

  it("matches along the edge two tiles share", () => {
    const left = buildGroundTile(gen, 0, 0);
    const right = buildGroundTile(gen, 1, 0);
    const f = GROUND_FLOATS_PER_VERTEX;
    // Every vertex of `left` on its far x edge has a twin on `right`'s near edge with the same
    // height, normal, weights and shade.
    const edge = new Map<number, number[]>();
    for (let v = 0; v < right.vertexCount; v++) {
      if (right.vertices[v * f] !== 0) continue;
      const z = Math.round((right.vertices[v * f + 2] as number) / GROUND_STEP);
      edge.set(z, [...right.vertices.slice(v * f, v * f + f)]);
    }
    let checked = 0;
    for (let v = 0; v < left.vertexCount; v++) {
      if (Math.abs((left.vertices[v * f] as number) - TILE_METERS) > 1e-6) continue;
      const z = Math.round((left.vertices[v * f + 2] as number) / GROUND_STEP);
      const twin = edge.get(z);
      expect(twin).toBeDefined();
      for (let k = 1; k < f; k++) {
        if (k === 2) continue; // z is tile-local on both
        expect(left.vertices[v * f + k]).toBeCloseTo(twin?.[k] as number, 6);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("open grave pits", () => {
  /** Finds an open grave, scanning cells outward until one turns up. */
  function findOpenGrave(): { grave: PropPlacement } {
    const out: Placement[] = [];
    for (let r = 0; r < 400; r++) {
      for (let cz = -r; cz <= r; cz++) {
        for (let cx = -r; cx <= r; cx++) {
          if (Math.max(Math.abs(cx), Math.abs(cz)) !== r) continue;
          out.length = 0;
          placeCell(gen, cx, cz, 1337, out);
          for (const p of out) {
            if (p.type === "prop" && p.kind === "grave" && !p.topsoil) return { grave: p };
          }
        }
      }
    }
    throw new Error("no open grave found");
  }

  const { grave } = findOpenGrave();
  const tx = tileOf(grave.x);
  const tz = tileOf(grave.z);

  it("meshes the tile around an open grave finer, with the ground sunk to the box's floor", () => {
    const tile = buildGroundTile(gen, tx, tz);
    expect(latticeCells(tile.lattice)).toBeGreaterThan(TILE_CELLS);
    expect(tile.vertexCount).toBe(latticeCells(tile.lattice) ** 2 * 6);

    const level = gen.groundHeight(grave.x, grave.z);
    const sunk = heightInTile(tile.lattice, tx, tz, grave.x, grave.z);
    expect(level - sunk).toBeGreaterThan(0.8);
    // Beside the grave the ground is untouched.
    const away = grave.x + 2.2 * Math.cos(grave.yaw) + 1.5;
    if (tileOf(away) === tx) {
      expect(heightInTile(tile.lattice, tx, tz, away, grave.z)).toBeCloseTo(gen.groundHeight(away, grave.z), 1);
    }
  });

  it("leaves the tile's edges where a plain neighbour expects them, wherever the pit is not", () => {
    const tile = buildGroundTile(gen, tx, tz);
    const plain = fillLattice(gen, tx, tz, createLattice());
    const pits = pitsNear(gen, tx, tz, []);
    const cells = latticeCells(tile.lattice);
    const side = cells + 1;
    let checked = 0;
    for (let j = 0; j <= cells; j++) {
      for (let i = 0; i <= cells; i++) {
        const onEdge = i === 0 || j === 0 || i === cells || j === cells;
        const x = tx * TILE_METERS + (i * TILE_METERS) / cells;
        const z = tz * TILE_METERS + (j * TILE_METERS) / cells;
        if (!onEdge || !Number.isNaN(pitFloorAt(pits, x, z))) continue;
        expect(tile.lattice[i + side * j]).toBeCloseTo(heightInTile(plain, tx, tz, x, z), 4);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
