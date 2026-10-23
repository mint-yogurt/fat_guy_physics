import { describe, expect, it } from "vitest";

import { CHUNK_SIZE, VOXEL_SIZE } from "../sim/constants.ts";
import { WORLD_CEILING_METERS } from "../sim/world.ts";
import { Biome } from "../voxel/biomeTint.ts";
import { floorDiv } from "../voxel/voxel.ts";
import { BIOME_SHEET, GRAVE_SHEET, OBJECT_SHEET, SPAWN_CHANCE } from "./generationSheet.ts";
import { GRAVE_BOX, PROP_METRICS } from "./props.ts";
import { placeCell, rollInterior, type Placement, type PropPlacement } from "./spawns.ts";
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
  it("stays under the world ceiling", () => {
    const ceiling = WORLD_CEILING_METERS / VOXEL_SIZE;
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
        if (entry.kind === "bush" || !entry.kind.match(/snowman|present|bucket|tombstone|grave|leafpile|snowbank|gbreadhouse/)) continue;
        expect(seen.get(entry.kind)?.has(biome), `${entry.kind} in ${BIOME_SHEET[biome].label}`).toBe(true);
      }
    }
    // And nothing the sheet does not list for the region.
    expect(seen.get("snowman_small")?.has(Biome.Halloween) ?? false).toBe(false);
    expect(seen.get("grave")?.has(Biome.Christmas) ?? false).toBe(false);
  });

  it("lays leaf piles flat, within 10% of authored size, and leaves them walk-through", () => {
    const piles = props.filter((p) => p.kind === "leafpile");
    expect(piles.length).toBeGreaterThan(50);
    expect(piles.every((p) => p.biome === Biome.Halloween)).toBe(true);
    const scales = piles.map((p) => p.scale);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(PROP_METRICS.leafpile.scale * 0.9);
    expect(Math.max(...scales)).toBeLessThanOrEqual(PROP_METRICS.leafpile.scale * 1.1);
    // Spread across the range, not pinned to one end.
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.15);
    for (const p of piles) {
      expect(p.tiltX).toBe(0);
      expect(p.tiltZ).toBe(0);
    }
    // Zero height is how the sim keeps a prop out of the crosshair's way.
    expect(PROP_METRICS.leafpile.height).toBe(0);
  });

  it("scatters snowbanks over the snow, 20% either way in size, ready to be hit for snow", () => {
    const banks = props.filter((p) => p.kind === "snowbank");
    expect(banks.length).toBeGreaterThan(50);
    expect(banks.every((p) => p.biome === Biome.Christmas)).toBe(true);
    const scales = banks.map((p) => p.scale);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(PROP_METRICS.snowbank.scale * 0.8);
    expect(Math.max(...scales)).toBeLessThanOrEqual(PROP_METRICS.snowbank.scale * 1.2);
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.12);
    // Aimable (the leaf pile is not), and the sheet gives snowballs out of it, several a hit.
    expect(PROP_METRICS.snowbank.height).toBeGreaterThan(0);
    expect(PROP_METRICS.snowbank.scoopable).toBe(true);
    const resource = OBJECT_SHEET.snowbank.resources?.[0];
    expect(resource?.item).toBe("snowball");
    expect(resource?.amount ?? 1).toBeGreaterThan(1);
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

describe("gingerbread houses", () => {
  /** About 3 km square of cells: enough Christmas ground for a few dozen houses. */
  const HOUSE_SCAN = 500;
  const christmasItems = BIOME_SHEET[Biome.Christmas].lootTable.map((e) => e.item);

  // A house brings its container with it, so keep them by cell.
  const houseCells: PropPlacement[][] = [];
  const everything: Placement[][] = [];
  const out: Placement[] = [];
  for (let cz = -HOUSE_SCAN; cz <= HOUSE_SCAN; cz++) {
    for (let cx = -HOUSE_SCAN; cx <= HOUSE_SCAN; cx++) {
      out.length = 0;
      placeCell(gen, cx, cz, SEED, out);
      const placed = out.filter((p): p is PropPlacement => p.type === "prop");
      if (placed.some((p) => p.kind === "gbreadhouse_1")) {
        houseCells.push(placed);
        everything.push([...out]);
      }
    }
  }
  const houses = houseCells.map((cell) => cell.find((p) => p.kind === "gbreadhouse_1") as PropPlacement);

  it("are rare, and only in the Christmas region", () => {
    expect(houses.length).toBeGreaterThan(20);
    expect(houses.every((h) => h.biome === Biome.Christmas)).toBe(true);
    // 1000 x 1000 cells = 10.2 km2; Christmas is about a fifth of the ground,
    // so ~one per 20,000 m2 of it is ~10 a km2 overall.
    const perKm2 = houses.length / (((2 * HOUSE_SCAN + 1) * CHUNK_SIZE * VOXEL_SIZE) ** 2 / 1e6);
    expect(perKm2).toBeLessThan(60);
    expect(perKm2).toBeGreaterThan(6);
  });

  it("hold exactly one item each, from the Christmas loot table", () => {
    for (const house of houses) {
      expect(house.loot).toHaveLength(1);
      expect(christmasItems).toContain(house.loot[0]);
    }
    // And they vary: not the same thing every time.
    expect(new Set(houses.map((h) => h.loot[0])).size).toBeGreaterThan(2);
  });

  it("have a present or gift standing in them about a fifth of the time", () => {
    const withContainer = houseCells.filter((cell) => cell.length > 1);
    const chance = OBJECT_SHEET.gbreadhouse_1.interior?.containerChance ?? 0;
    expect(chance).toBeCloseTo(0.2);
    expect(withContainer.length / houses.length).toBeGreaterThan(chance - 0.12);
    expect(withContainer.length / houses.length).toBeLessThan(chance + 0.12);
    for (const cell of withContainer) {
      const house = cell.find((p) => p.kind === "gbreadhouse_1") as PropPlacement;
      const container = cell.find((p) => p.kind !== "gbreadhouse_1") as PropPlacement;
      expect(["present_small", "present_big"]).toContain(container.kind);
      expect(container.x).toBe(house.x);
      expect(container.z).toBe(house.z);
      expect(container.y).toBe(house.y);
      expect(container.id).not.toBe(house.id);
      for (const item of container.loot) expect(christmasItems).toContain(item);
    }
  });

  it("keep clear of whatever the cells around them hold", () => {
    expect(everything.length).toBe(houses.length);
    const scratch: Placement[] = [];
    for (const house of houses) {
      const reach = PROP_METRICS.gbreadhouse_1.radius * house.scale;
      const cx = floorDiv(Math.floor(house.x / VOXEL_SIZE), CHUNK_SIZE);
      const cz = floorDiv(Math.floor(house.z / VOXEL_SIZE), CHUNK_SIZE);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          scratch.length = 0;
          placeCell(gen, cx + dx, cz + dz, SEED, scratch, false);
          for (const other of scratch) {
            const ox = other.type === "prop" ? other.x : (other.rootVoxelX + 0.5) * VOXEL_SIZE;
            const oz = other.type === "prop" ? other.z : (other.rootVoxelZ + 0.5) * VOXEL_SIZE;
            expect(Math.hypot(ox - house.x, oz - house.z)).toBeGreaterThanOrEqual(reach);
          }
        }
      }
    }
  });

  it("only go on level ground", () => {
    for (const h of houses) {
      const vx = Math.floor(h.x / VOXEL_SIZE);
      const vz = Math.floor(h.z / VOXEL_SIZE);
      const centre = gen.surfaceHeight(vx, vz);
      const reach = Math.ceil((PROP_METRICS.gbreadhouse_1.radius * h.scale) / VOXEL_SIZE);
      for (const [dx, dz] of [[reach, 0], [-reach, 0], [0, reach], [0, -reach]] as const) {
        expect(Math.abs(gen.surfaceHeight(vx + dx, vz + dz) - centre)).toBeLessThanOrEqual(
          OBJECT_SHEET.gbreadhouse_1.maxSlope ?? 0,
        );
      }
    }
  });

  it("draw their item by rarity: common three times uncommon, uncommon three times rare", () => {
    const counts = new Map<string, number>();
    const N = 30000;
    for (let id = 1; id <= N; id++) {
      const [item] = rollInterior("gbreadhouse_1", Biome.Christmas, id * 2654435761 >>> 0);
      counts.set(item ?? "", (counts.get(item ?? "") ?? 0) + 1);
    }
    // common 0.6, 4 x uncommon 0.3, 4 x rare 0.1 in weight, out of 0.6 + 1.2 + 0.4 = 2.2.
    expect((counts.get("mountain_lightning") ?? 0) / N).toBeGreaterThan(0.25);
    expect((counts.get("mountain_lightning") ?? 0) / N).toBeLessThan(0.3);
    for (const item of ["xmas_lights", "snowball", "log", "stick"]) {
      expect((counts.get(item) ?? 0) / N, item).toBeGreaterThan(0.12);
      expect((counts.get(item) ?? 0) / N, item).toBeLessThan(0.15);
    }
    for (const item of ["eggnog", "coal", "metal", "candy"]) {
      expect((counts.get(item) ?? 0) / N, item).toBeGreaterThan(0.03);
      expect((counts.get(item) ?? 0) / N, item).toBeLessThan(0.06);
    }
  });

  it("have nothing inside where the region has no loot table", () => {
    expect(rollInterior("gbreadhouse_1", Biome.Halloween, 12345)).toEqual([]);
  });
});

describe("Christmas presents", () => {
  it("are stocked from the Christmas loot table", () => {
    const table = BIOME_SHEET[Biome.Christmas].lootTable.map((e) => e.item);
    const presents = props.filter((p) => p.kind === "present_small" || p.kind === "present_big");
    expect(presents.length).toBeGreaterThan(10);
    expect(presents.some((p) => p.loot.length > 0)).toBe(true);
    for (const present of presents) for (const item of present.loot) expect(table).toContain(item);
  });
});
