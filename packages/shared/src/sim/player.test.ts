import { describe, expect, it } from "vitest";

import goldenJson from "../../../../tools/golden/golden.json" with { type: "json" };

import type { SolidQuery } from "./collision.ts";
import { CHUNK_SIZE } from "./constants.ts";
import { createPlayerInput, Player, PlayerMode } from "./player.ts";
import { VERTICAL_CHUNK_MAX, VERTICAL_CHUNK_MIN } from "./world.ts";
import { floorDiv, floorMod, isSolid, Material } from "../voxel/voxel.ts";
import { createChunkGrid, gridIndex, type VoxelGrid } from "../voxel/voxelGrid.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";

/**
 * Asserts the ported player and collision code against a trace recorded from
 * the C++ build (see tools/golden/dump-golden.sh, which compiles the real,
 * unmodified Collision.cpp and Player.cpp headlessly against a stub World).
 *
 * This test exists because Collision.cpp is the most behaviourally fragile
 * code in the project: a dozen hand-tuned epsilons, an asymmetric floor/ceil
 * bias, and a step-up search whose exit conditions were arrived at
 * empirically. A port that is 99% right is indistinguishable from one that
 * is 100% right until someone walks into a particular ledge at a particular
 * angle.
 */

interface GoldenTrace {
  spawnY: number;
  fixedTimestep: number;
  script: { n: number; mx: number; mz: number; jump: boolean; toggle: boolean; yaw: number }[];
  /** [x, y, z, grounded, mode] per substep. */
  steps: [number, number, number, number, number][];
}

const golden = goldenJson as unknown as { seed: number; playerTrace: GoldenTrace };

/**
 * Terrain-only solidity, generated on demand and cached. Mirrors
 * tools/golden/stub/World.hpp exactly, including the vertical band outside
 * which everything reads as Air -- that is what lets a fall off the world
 * reach the kill plane in both implementations.
 */
class TraceQuery implements SolidQuery {
  private readonly generator: TerrainGenerator;
  private readonly chunks = new Map<string, VoxelGrid>();

  constructor(seed: number) {
    // The reference world has no biomes, and with them on the heights are
    // no longer the C++'s -- so this must be the biome-free generator, as
    // terrain.test.ts uses.
    this.generator = new TerrainGenerator(seed, false);
  }

  surfaceHeightVoxels(x: number, z: number): number {
    return this.generator.surfaceHeight(x, z);
  }

  isSolid(vx: number, vy: number, vz: number): boolean {
    const cy = floorDiv(vy, CHUNK_SIZE);
    if (cy < VERTICAL_CHUNK_MIN || cy > VERTICAL_CHUNK_MAX) return false;

    const cx = floorDiv(vx, CHUNK_SIZE);
    const cz = floorDiv(vz, CHUNK_SIZE);
    const key = `${cx},${cy},${cz}`;
    let grid = this.chunks.get(key);
    if (grid === undefined) {
      grid = createChunkGrid();
      this.generator.generate(grid, cx, cy, cz);
      this.chunks.set(key, grid);
    }
    const material = grid.cells[
      gridIndex(
        grid,
        floorMod(vx, CHUNK_SIZE),
        floorMod(vy, CHUNK_SIZE),
        floorMod(vz, CHUNK_SIZE),
      )
    ] as Material;
    return isSolid(material);
  }
}

/** Walking agrees with the reference to last-bit float noise. */
const WALKING_TOLERANCE = 1e-4;

/** Ragball is chaotic; see the comment at the assertion for why. */
const RAGBALL_TOLERANCE = 0.02;

describe("player trace vs the C++ reference", () => {
  const trace = golden.playerTrace;

  it("has a fixture that actually exercises both modes and real movement", () => {
    // Guards the fixture itself: a script that never leaves the spawn block,
    // never leaves the ground, or never enters Ragball would pass every
    // assertion below while testing almost nothing.
    expect(trace.steps.length).toBeGreaterThan(500);
    const modes = new Set(trace.steps.map((s) => s[4]));
    expect(modes).toEqual(new Set([0, 1]));
    const airborne = trace.steps.filter((s) => s[3] === 0).length;
    expect(airborne).toBeGreaterThan(20);
    const travel = Math.hypot(
      trace.steps[trace.steps.length - 1]?.[0] ?? 0,
      trace.steps[trace.steps.length - 1]?.[2] ?? 0,
    );
    expect(travel).toBeGreaterThan(5);
  });

  it("reproduces position, grounded state and mode substep by substep", () => {
    const query = new TraceQuery(golden.seed);
    const player = new Player(0, trace.spawnY, 0);
    // The trace was recorded against the C++ collider, which the game has
    // since widened to fit the player model.
    player.halfWidth = 0.3;
    player.ballRadius = 0.4;
    const input = createPlayerInput();
    const surface = (): number => query.surfaceHeightVoxels(0, 0);

    let step = 0;
    let worstDelta = 0;
    let sawRagball = false;

    for (const segment of trace.script) {
      if (segment.toggle) player.toggleMode(query);
      if (segment.yaw !== 0) player.look(segment.yaw, 0);

      for (let i = 0; i < segment.n; i++) {
        input.moveX = segment.mx;
        input.moveZ = segment.mz;
        input.jumpPressed = segment.jump && i === 0;
        player.update(input, trace.fixedTimestep, query, surface);

        const expected = trace.steps[step];
        expect(expected, `missing golden step ${String(step)}`).toBeDefined();
        if (expected === undefined) return;

        const delta = Math.hypot(
          player.x - expected[0],
          player.y - expected[1],
          player.z - expected[2],
        );
        if (delta > worstDelta) worstDelta = delta;

        // Tolerance rather than exact equality, because the C++ computes in
        // float32 and this computes in float64 -- the two differ in the last
        // bits of every operation. How much that compounds depends entirely
        // on the mode, so the two get very different budgets:
        //
        //  - Walking is a near-exact match: 390 substeps of ledges, jumps,
        //    diagonals and step-ups agree to ~1e-5 m, which is last-bit
        //    noise and nothing else. This is the number that matters, since
        //    sweepAabb and its epsilons are the fragile part.
        //  - Ragball is chaotic by nature. sweepSphere resolves penetration
        //    iteratively against a voxel lattice, so a ball rolling over
        //    bumpy terrain amplifies any difference in input -- two runs
        //    that differ in the 7th decimal separate measurably within a
        //    few hundred substeps. 2cm over 360 substeps is agreement, not
        //    drift; a genuine logic error here moves the ball by whole
        //    voxels within a handful of substeps, not by millimetres over
        //    hundreds.
        //
        // The budget widens at the first Ragball substep and stays widened:
        // walking after a roll inherits wherever the ball came to rest, so
        // holding it to the pre-roll tolerance would be measuring the roll,
        // not the walk.
        if (expected[4] === 1) sawRagball = true;
        const tolerance = sawRagball ? RAGBALL_TOLERANCE : WALKING_TOLERANCE;
        expect(
          delta,
          `step ${String(step)}: got ${player.x.toFixed(4)},${player.y.toFixed(4)},${player.z.toFixed(4)} want ${expected[0].toFixed(4)},${expected[1].toFixed(4)},${expected[2].toFixed(4)}`,
        ).toBeLessThan(tolerance);

        // These are discrete decisions, not accumulated floats -- they must
        // match exactly. Grounded in particular gates jumping and the
        // step-up assist, so a single wrong frame changes everything after.
        expect(player.grounded ? 1 : 0, `grounded at step ${String(step)}`).toBe(expected[3]);
        expect(
          player.mode === PlayerMode.Walking ? 0 : 1,
          `mode at step ${String(step)}`,
        ).toBe(expected[4]);

        step++;
      }
    }

    expect(step).toBe(trace.steps.length);
    // Surfaced so a regression that merely loosens agreement shows up as a
    // number rather than silently passing just inside the tolerance.
    expect(worstDelta).toBeLessThan(RAGBALL_TOLERANCE);
  });
});
