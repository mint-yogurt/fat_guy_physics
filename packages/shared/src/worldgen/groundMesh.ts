import { VOXEL_SIZE } from "../sim/constants.ts";
import { GROUND } from "./generationSheet.ts";
import { pitFloorAt, pitsNear, type Pit } from "./gravePits.ts";
import {
  createLattice,
  fillLattice,
  GROUND_STEP,
  heightInTile,
  TILE_CELLS,
  TILE_METERS,
} from "./groundField.ts";
import type { TerrainGenerator } from "./terrainGenerator.ts";
import { createBiomeWeights } from "./biome.ts";

/**
 * Turns one tile of the ground field into a triangle list for rendering and physics.
 *
 * Per vertex, in this order (`GROUND_FLOATS_PER_VERTEX` floats):
 *   position (3)  tile-local x and z, absolute y, metres
 *   normal (3)    smooth, from the surrounding heights
 *   weights (3)   how much of grass, dirt and snow texture shows here (sum to 1)
 *   tint (3)      colour multiplier
 *   shade (1)     the sun's light on this vertex, baked (Gouraud), 0..1
 *   spooky (1)    how Halloween this ground is: drained of colour by the shader
 *
 * The vertex values are computed for the lattice's vertices once and shared by the triangles
 * around them, and from the generator alone (not from neighbouring tiles), so two tiles that
 * share an edge agree on every value along it and no seam shows.
 */

export const GROUND_FLOATS_PER_VERTEX = 14;
export const OFFSET_POSITION = 0;
export const OFFSET_NORMAL = 3;
export const OFFSET_WEIGHTS = 6;
export const OFFSET_TINT = 9;
export const OFFSET_SHADE = 12;
export const OFFSET_SPOOKY = 13;

/** The direction the sun's baked light comes from; the same sun the atmosphere lights props with. */
export const SUN_DIRECTION: readonly [number, number, number] = (() => {
  const x = 0.4;
  const y = 1.0;
  const z = 0.3;
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
})();

export interface GroundTile {
  /** The vertex heights (a square, row-major by z then x); what the solid test and the raycast read. */
  lattice: Float32Array;
  /** Exactly `vertexCount * GROUND_FLOATS_PER_VERTEX` long. */
  vertices: Float32Array;
  vertexCount: number;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

const weightsScratch = createBiomeWeights();

/** How much of each ground texture shows at a point, and how Halloween it is. */
export interface GroundBlend {
  grass: number;
  dirt: number;
  snow: number;
  /** 0..1: Halloween's weight here. */
  spooky: number;
}

/**
 * The ground's look at (x, z) metres, given the slope there (rise per metre). Snow is the
 * Christmas biome; elsewhere dirt shows in slow patches and wherever the ground is steep.
 * The weights sum to 1.
 */
export function groundBlend(
  generator: TerrainGenerator,
  x: number,
  z: number,
  slope: number,
  out: GroundBlend,
): GroundBlend {
  const biome = generator.biomeAt(Math.floor(x / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE), weightsScratch);
  const snow = biome.christmas;
  const dirt = Math.max(
    generator.dirtPatch(x, z),
    smoothstep(GROUND.slopeDirtStart, GROUND.slopeDirtFull, slope),
  );
  const earth = 1 - snow;
  out.grass = earth * (1 - dirt);
  out.dirt = earth * dirt;
  out.snow = snow;
  out.spooky = biome.halloween;
  return out;
}

const blendScratch: GroundBlend = { grass: 0, dirt: 0, snow: 0, spooky: 0 };

/** Writes one lattice vertex's attributes (everything after position) into `out` at `at`. */
function vertexAttributes(generator: TerrainGenerator, x: number, z: number, out: Float32Array, at: number): void {
  const s = GROUND_STEP;
  const dx = (generator.smoothHeight(x + s, z) - generator.smoothHeight(x - s, z)) / (2 * s);
  const dz = (generator.smoothHeight(x, z + s) - generator.smoothHeight(x, z - s)) / (2 * s);
  const length = Math.hypot(dx, 1, dz);
  const nx = -dx / length;
  const ny = 1 / length;
  const nz = -dz / length;

  const blend = groundBlend(generator, x, z, Math.hypot(dx, dz), blendScratch);

  out[at] = nx;
  out[at + 1] = ny;
  out[at + 2] = nz;
  out[at + 3] = blend.grass;
  out[at + 4] = blend.dirt;
  out[at + 5] = blend.snow;
  // Colour multiplier. Halloween's darkening is applied here; its drained colour in the shader.
  const dark = 1 - blend.spooky * GROUND.halloweenDarkening;
  out[at + 6] = dark;
  out[at + 7] = dark;
  out[at + 8] = dark;
  out[at + 9] = Math.max(0, nx * SUN_DIRECTION[0] + ny * SUN_DIRECTION[1] + nz * SUN_DIRECTION[2]);
  out[at + 10] = blend.spooky;
}

const ATTRIBUTES = GROUND_FLOATS_PER_VERTEX - 3;

/** A tile with an open grave in it is built this many times finer, so the pit has walls. */
const PIT_REFINE = 4;
const MAX_SIDE = TILE_CELLS * PIT_REFINE + 1;
const attributeScratch = new Float32Array(MAX_SIDE * MAX_SIDE * ATTRIBUTES);
const pitScratch: Pit[] = [];

/** Meshes tile (cx, cz). Allocates its result; the scratch is internal and per thread. */
export function buildGroundTile(generator: TerrainGenerator, cx: number, cz: number): GroundTile {
  const coarse = fillLattice(generator, cx, cz, createLattice());
  const pits = pitsNear(generator, cx, cz, pitScratch);
  const cells = pits.length > 0 ? TILE_CELLS * PIT_REFINE : TILE_CELLS;
  const side = cells + 1;
  const step = TILE_METERS / cells;
  const originX = cx * TILE_METERS;
  const originZ = cz * TILE_METERS;

  // The heights: the coarse ground, and a finer copy with the pits cut in when there are any.
  let lattice = coarse;
  const lowered = new Uint8Array(side * side);
  if (cells !== TILE_CELLS) {
    lattice = new Float32Array(side * side);
    for (let j = 0; j < side; j++) {
      for (let i = 0; i < side; i++) {
        const x = originX + i * step;
        const z = originZ + j * step;
        let h = heightInTile(coarse, cx, cz, x, z);
        const floor = pitFloorAt(pits, x, z);
        if (!Number.isNaN(floor) && floor < h) {
          h = floor;
          lowered[i + side * j] = 1;
        }
        lattice[i + side * j] = h;
      }
    }
  }

  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const at = (i + side * j) * ATTRIBUTES;
      vertexAttributes(generator, originX + i * step, originZ + j * step, attributeScratch, at);
      if (lowered[i + side * j] === 1) {
        // The floor of a pit is bare earth.
        attributeScratch[at + 3] = 0;
        attributeScratch[at + 4] = 1;
        attributeScratch[at + 5] = 0;
      }
    }
  }

  const vertexCount = cells * cells * 6;
  const vertices = new Float32Array(vertexCount * GROUND_FLOATS_PER_VERTEX);
  let at = 0;
  const emit = (i: number, j: number): void => {
    const index = i + side * j;
    vertices[at++] = i * step;
    vertices[at++] = lattice[index] as number;
    vertices[at++] = j * step;
    const from = index * ATTRIBUTES;
    for (let k = 0; k < ATTRIBUTES; k++) vertices[at++] = attributeScratch[from + k] as number;
  };

  // Two triangles a cell, split along the (i, j) -> (i+1, j+1) diagonal like groundField's
  // interpolation, wound so the front face looks up (+y).
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      emit(i, j);
      emit(i + 1, j + 1);
      emit(i + 1, j);
      emit(i, j);
      emit(i, j + 1);
      emit(i + 1, j + 1);
    }
  }

  return { lattice, vertices, vertexCount };
}
