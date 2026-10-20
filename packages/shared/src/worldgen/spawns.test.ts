import { describe, expect, it } from "vitest";

import { CHUNK_SIZE, VOXEL_SIZE } from "../sim/constants.ts";
import { VERTICAL_CHUNK_MAX } from "../sim/world.ts";
import { Biome } from "../voxel/biomeTint.ts";
import { Material, floorDiv } from "../voxel/voxel.ts";
import { createChunkGrid } from "../voxel/voxelGrid.ts";
import { BIOME_SHEET, GRAVE_SHEET, SPAWN_CHANCE } from "./generationSheet.ts";
import { GRAVE_BOX } from "./props.ts";
import { placeCell, type Placement, type PropPlacement } from "./spawns.ts";
import { TerrainGenerator } from "./terrainGenerator.ts";

const SEED = 1337;
const gen = new TerrainGenerator(SEED);

/** Cells to scan: about 1 km square, which covers every region several times. */
const SCAN = 150;

function scan(): PropPlacement[][] {
  // Grouped by cell, so a grave stays with its tombstone.
  const cells: PropPlacement[][] = [];
  const out: Placement[] = [];
  for (let cz = -SCAN; cz <= SCAN; cz++) {
    for (let cx = -SCAN; cx <= SCAN; cx++) {
      out.length = 0;
      placeCell(gen, cx, cz, SEED, out);
      const props = out.filter((p): p is PropPlacement => p.type === "prop");
      if (props.length > 0) cells.push(props);
    }
  }
  return cells;
}

const cells = scan();
const props = cells.flat();

describe("generation sheet", () => {
  it("keeps every region's spawn chances under 1", () => {
    for (const biome of [Biome.Plain, Biome.Christmas, Biome.Halloween]) {
      const total = BIOME_SHEET[biome].spawns.reduce((sum, e) => sum + SPAWN_CHANCE[e.rarity], 0);
      expect(total).toBeLessThan(1);
    }
  });
});

describe("biome terrain", () => {
  it("stays inside the loaded vertical band", () => {
    const ceiling = (VERTICAL_CHUNK_MAX + 1) * CHUNK_SIZE;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let z = -6000; z < 6000; z += 41) {
      for (let x = -6000; x < 6000; x += 41) {
        const h = gen.surfaceHeight(x, z);
        lowest = Math.min(lowest, h);
        highest = Math.max(highest, h);
      }
    }
    expect(lowest).toBeGreaterThan(0);
    expect(highest).toBeLessThan(ceiling);
  });

  it("makes cliffs somewhere: a drop of a metre or more between neighbours", () => {
    let sheerest = 0;
    for (let z = -4000; z < 4000; z += 7) {
      for (let x = -4000; x < 4000; x += 7) {
        sheerest = Math.max(sheerest, Math.abs(gen.surfaceHeight(x, z) - gen.surfaceHeight(x + 1, z)));
      }
    }
    expect(sheerest).toBeGreaterThanOrEqual(10);
  });
});

describe("placement", () => {
  it("is deterministic", () => {
    const a: Placement[] = [];
    const b: Placement[] = [];
    for (const [cx, cz] of [[0, 0], [17, -9], [-80, 44], [120, 120]] as const) {
      a.length = 0;
      b.length = 0;
      placeCell(gen, cx, cz, SEED, a);
      placeCell(gen, cx, cz, SEED, b);
      expect(b).toEqual(a);
    }
  });

  it("produces every prop the sheet lists, in the regions it lists them", () => {
    const seen = new Map<string, Set<Biome>>();
    for (const p of props) {
      let set = seen.get(p.kind);
      if (set === undefined) seen.set(p.kind, (set = new Set()));
      set.add(p.biome);
    }
    for (const biome of [Biome.Christmas, Biome.Halloween]) {
      for (const entry of BIOME_SHEET[biome].spawns) {
        if (entry.kind === "bush" || !entry.kind.match(/snowman|present|tombstone|grave/)) continue;
        expect(seen.get(entry.kind)?.has(biome), `${entry.kind} in ${BIOME_SHEET[biome].label}`).toBe(true);
      }
    }
    // And nothing the sheet does not list for the region.
    expect(seen.get("snowman_small")?.has(Biome.Halloween) ?? false).toBe(false);
    expect(seen.get("grave")?.has(Biome.Christmas) ?? false).toBe(false);
  });

  it("dresses graves as the sheet says", () => {
    const graves = props.filter((p) => p.kind === "grave");
    expect(graves.length).toBeGreaterThan(50);

    const crooked = graves.filter((g) => g.tiltX !== 0 || g.tiltZ !== 0);
    expect(crooked.length / graves.length).toBeGreaterThan(GRAVE_SHEET.crookedChance - 0.12);
    expect(crooked.length / graves.length).toBeLessThan(GRAVE_SHEET.crookedChance + 0.12);
    for (const g of crooked) {
      // One side only, between the sheet's limits.
      expect(g.tiltX === 0 || g.tiltZ === 0).toBe(true);
      const degrees = (Math.abs(g.tiltX + g.tiltZ) * 180) / Math.PI;
      expect(degrees).toBeGreaterThanOrEqual(GRAVE_SHEET.crookedMinDegrees - 1e-9);
      expect(degrees).toBeLessThanOrEqual(GRAVE_SHEET.crookedMaxDegrees + 1e-9);
    }

    const covered = graves.filter((g) => g.topsoil).length / graves.length;
    expect(covered).toBeGreaterThan(GRAVE_SHEET.topsoilChance - 0.12);
    expect(covered).toBeLessThan(GRAVE_SHEET.topsoilChance + 0.12);
  });

  it("puts a grave's tombstone at its x- end", () => {
    let checked = 0;
    for (const cell of cells) {
      const grave = cell.find((p) => p.kind === "grave");
      const stone = cell.find((p) => p.kind.startsWith("tombstone"));
      if (grave === undefined || stone === undefined) continue;
      // Into the grave's own frame: along its length is local X.
      const dx = stone.x - grave.x;
      const dz = stone.z - grave.z;
      const along = dx * Math.cos(grave.yaw) - dz * Math.sin(grave.yaw);
      const across = dx * Math.sin(grave.yaw) + dz * Math.cos(grave.yaw);
      expect(along).toBeLessThan(-GRAVE_BOX.halfLength * grave.scale);
      expect(Math.abs(across)).toBeLessThan(0.01);
      expect(stone.yaw).toBe(grave.yaw);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });

  it("only places graves on level ground", () => {
    for (const g of props.filter((p) => p.kind === "grave")) {
      const vx = Math.floor(g.x / VOXEL_SIZE);
      const vz = Math.floor(g.z / VOXEL_SIZE);
      const centre = gen.surfaceHeight(vx, vz);
      for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10]] as const) {
        expect(Math.abs(gen.surfaceHeight(vx + dx, vz + dz) - centre)).toBeLessThanOrEqual(3);
      }
    }
  });
});

describe("open graves", () => {
  /** The voxel at a world position, generating whichever chunk holds it. */
  function voxelAt(x: number, y: number, z: number): Material {
    const vx = Math.floor(x / VOXEL_SIZE);
    const vy = Math.floor(y / VOXEL_SIZE);
    const vz = Math.floor(z / VOXEL_SIZE);
    const grid = createChunkGrid();
    gen.generate(grid, floorDiv(vx, CHUNK_SIZE), floorDiv(vy, CHUNK_SIZE), floorDiv(vz, CHUNK_SIZE));
    const lx = vx - floorDiv(vx, CHUNK_SIZE) * CHUNK_SIZE;
    const ly = vy - floorDiv(vy, CHUNK_SIZE) * CHUNK_SIZE;
    const lz = vz - floorDiv(vz, CHUNK_SIZE) * CHUNK_SIZE;
    return grid.cells[lx + CHUNK_SIZE * (ly + CHUNK_SIZE * lz)] as Material;
  }

  const graves = props.filter((p) => p.kind === "grave");

  it("hollows the pit under an open grave and leaves a covered one solid", () => {
    const open = graves.filter((g) => !g.topsoil && g.tiltX === 0 && g.tiltZ === 0).slice(0, 12);
    const covered = graves.filter((g) => g.topsoil).slice(0, 12);
    expect(open.length).toBeGreaterThan(0);

    for (const g of open) {
      // Half a metre down the middle is inside the box whatever the yaw.
      expect(voxelAt(g.x, g.y - 0.5, g.z), `open grave at ${g.x},${g.z}`).toBe(Material.Air);
    }
    for (const g of covered) {
      expect(voxelAt(g.x, g.y - 0.5, g.z), `covered grave at ${g.x},${g.z}`).not.toBe(Material.Air);
    }
  });

  it("leaves the ground beside the pit alone", () => {
    for (const g of graves.filter((p) => !p.topsoil).slice(0, 8)) {
      // Well past the box's half-width, on the grave's own side axis.
      const side = (GRAVE_BOX.halfWidth * g.scale + 0.5);
      const x = g.x + side * Math.sin(g.yaw);
      const z = g.z + side * Math.cos(g.yaw);
      expect(voxelAt(x, g.y - 0.5, z)).not.toBe(Material.Air);
    }
  });
});
