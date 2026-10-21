import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { PLAYER_MASS } from "../sim/player.ts";
import { Biome } from "../voxel/biomeTint.ts";
import { BIOME_SHEET } from "../worldgen/generationSheet.ts";
import { PROP_METRICS } from "../worldgen/props.ts";
import { placeCell, type Placement } from "../worldgen/spawns.ts";
import { TerrainGenerator } from "../worldgen/terrainGenerator.ts";
import { isRock, placeRock, ROCK_RADIUS, spawnRock } from "./rock.ts";
import { BallRopeBody } from "./rope.ts";
import { SNOW_UNIT_RADIUS, SnowballField } from "./snowball.ts";

const DT = 1 / 120;
const terrain = (height: (x: number, z: number) => number): SolidQuery => ({
  isSolid: (vx, vy, vz) =>
    (vy + 0.5) * VOXEL_SIZE < height((vx + 0.5) * VOXEL_SIZE, (vz + 0.5) * VOXEL_SIZE),
});
const flat = terrain(() => 1);
const snowy = (): boolean => true;

function run(field: SnowballField, query: SolidQuery, seconds: number): void {
  for (let i = 0; i < seconds / DT; i++) field.step(DT, query, snowy);
}

/** A walker moving at `speed` along +x, into a rock at the origin. */
function shoveFrom(field: SnowballField, speed: number): void {
  field.pushedBy(-0.6, 1, 0, speed, 0, 0.55, 1.9, PLAYER_MASS);
}

describe("a rock in the world", () => {
  it("lies where it was put, still, however long it is left", () => {
    const field = new SnowballField();
    const rock = placeRock(field, 7, 3, 1, 4, 1);
    const [x, y, z] = [rock.x, rock.y, rock.z];
    run(field, flat, 10);
    expect([rock.x, rock.y, rock.z]).toEqual([x, y, z]);
    expect(rock.rolling).toBe(false);
    expect(isRock(rock)).toBe(true);
    // Sits on the ground rather than hovering over it.
    expect(rock.y - rock.radius).toBeCloseTo(1, 6);
    expect(rock.worldId).toBe(7);
  });

  it("weighs what its size says: heavy, and more the bigger it is", () => {
    const field = new SnowballField();
    const small = placeRock(field, 1, 0, 1, 0, 0.7);
    const standard = placeRock(field, 2, 5, 1, 0, 1);
    const big = placeRock(field, 3, 10, 1, 0, 1.3);
    expect(standard.mass).toBeGreaterThan(15);
    expect(standard.mass).toBeLessThan(40);
    expect(small.mass).toBeLessThan(standard.mass / 2);
    expect(big.mass).toBeGreaterThan(standard.mass * 2);
    const snowball = field.spawn(0, 2, 0, 0, 0, 0, SNOW_UNIT_RADIUS);
    expect(standard.mass).toBeGreaterThan(snowball.mass * 20);
  });

  it("is shoved by a walker, but not at the walker's speed, and pushes back", () => {
    const field = new SnowballField();
    const rock = placeRock(field, 1, 0, 1, 0, 1);
    shoveFrom(field, 4.5);
    expect(rock.rolling).toBe(true);
    expect(rock.vx).toBeGreaterThan(1);
    expect(rock.vx).toBeLessThan(4.5 * 0.95);
    expect(field.reaction.x).toBeLessThan(0);
    // Whatever the rock gained, the walker lost: momentum is conserved.
    expect(-field.reaction.x).toBeCloseTo(rock.mass * rock.vx, 6);
  });

  it("is shoved by a walker as a snowball is, which has no weight to push back with", () => {
    const field = new SnowballField();
    const ball = field.spawn(0, 1 + SNOW_UNIT_RADIUS, 0, 0, 0, 0);
    field.pushedBy(-0.6, 1, 0, 4.5, 0, 0.55, 1.9, PLAYER_MASS);
    expect(ball.vx).toBeGreaterThan(4.5);
    expect(field.reaction.x).toBe(0);
  });

  it("rolls a little and stops, without growing on snow", () => {
    const field = new SnowballField();
    const rock = placeRock(field, 1, 0, 1, 0, 1);
    shoveFrom(field, 4.5);
    run(field, flat, 6);
    expect(rock.x).toBeGreaterThan(0.3);
    expect(rock.x).toBeLessThan(8);
    expect(rock.rolling).toBe(false);
    expect(rock.radius).toBe(ROCK_RADIUS);
  });

  it("stays put on a slope that would send a snowball down", () => {
    const slope = terrain((x) => 1 + x * 0.3);
    const field = new SnowballField();
    const rock = placeRock(field, 1, 5, 1 + 5 * 0.3, 0, 1);
    const ball = field.spawn(5, 1 + 5 * 0.3 + SNOW_UNIT_RADIUS, 3, 0, 0, 0);
    run(field, slope, 8);
    expect(Math.abs(rock.x - 5)).toBeLessThan(0.05);
    expect(rock.rolling).toBe(false);
    expect(ball.x).not.toBeCloseTo(5, 1);
  });

  it("is not forgotten when nobody is near, as snow is", () => {
    const field = new SnowballField();
    const rock = placeRock(field, 1, 0, 1, 0, 1);
    const ball = field.spawn(1, 1 + SNOW_UNIT_RADIUS, 0, 0, 0, 0);
    ball.settle();
    for (let i = 0; i < 400; i++) field.tick(1, 1000, 1000, 50);
    expect(field.balls).toContain(rock);
    expect(field.balls).not.toContain(ball);
  });

  it("is shoved by a blow, as much as its weight lets it", () => {
    const field = new SnowballField();
    const small = placeRock(field, 1, 0, 1, 0, 0.7);
    const big = placeRock(field, 2, 5, 1, 0, 1.3);
    small.shove(9, 0, 0, 12);
    big.shove(9, 0, 0, 12);
    expect(small.vx).toBeGreaterThan(big.vx * 2);
    expect(big.vx).toBeGreaterThan(0.3);
  });

  it("falls when the ground under it is dug away", () => {
    let floor = 1;
    const ground: SolidQuery = { isSolid: (_x, vy) => (vy + 0.5) * VOXEL_SIZE < floor };
    const field = new SnowballField();
    const rock = placeRock(field, 1, 0, 1, 0, 1);
    run(field, ground, 1);
    expect(rock.y).toBeCloseTo(1 + ROCK_RADIUS, 6);
    floor = 0.2;
    run(field, ground, 2);
    expect(rock.y).toBeLessThan(0.2 + ROCK_RADIUS + 0.05);
    expect(rock.y).toBeLessThan(1);
  });
});

describe("a rock thrown", () => {
  it("lands, bounces, and settles where it stops", () => {
    const field = new SnowballField();
    const rock = spawnRock(field, 0, 2.5, 0, 6, 0, 0);
    let highestAfterLanding = 0;
    let landed = false;
    for (let i = 0; i < 6 / DT; i++) {
      field.step(DT, flat, snowy);
      if (rock.y - rock.radius < 1.02) landed = true;
      else if (landed) highestAfterLanding = Math.max(highestAfterLanding, rock.y - rock.radius - 1);
    }
    expect(landed).toBe(true);
    expect(highestAfterLanding).toBeGreaterThan(0.05); // it bounced
    expect(rock.rolling).toBe(false);
    expect(rock.x).toBeGreaterThan(2);
    expect(rock.y - rock.radius).toBeCloseTo(1, 1);
  });

  it("knocks a rock it hits, by weight", () => {
    const field = new SnowballField();
    const lying = placeRock(field, 1, 1.2, 1, 0, 1);
    const flying = spawnRock(field, 0, 1 + ROCK_RADIUS, 0, 8, 0, 0);
    run(field, flat, 1);
    expect(lying.x).toBeGreaterThan(1.2);
    expect(flying.x).toBeGreaterThan(0.5);
  });
});

describe("a rope tied to a rock", () => {
  it("drags it, but a rock is harder to drag than a snowball", () => {
    const pull = (heavy: boolean): number => {
      const field = new SnowballField();
      const ball = heavy
        ? placeRock(field, 1, 0, 1, 0, 1)
        : field.spawn(0, 1 + SNOW_UNIT_RADIUS, 0, 0, 0, 0);
      ball.settle();
      const body = new BallRopeBody(ball, ball.x - 0.2, ball.y, ball.z);
      body.push(-40, 0, 0); // 40 N*s: a hard tug
      return Math.abs(ball.vx);
    };
    const rock = pull(true);
    const snow = pull(false);
    expect(rock).toBeGreaterThan(0.5);
    expect(snow).toBeGreaterThan(rock * 20);
  });

  it("lets go when the rock is picked up", () => {
    const field = new SnowballField();
    const rock = placeRock(field, 1, 0, 1, 0, 1);
    const body = new BallRopeBody(rock, 0, rock.y, 0);
    const point = { x: 0, y: 0, z: 0 };
    expect(body.tiePoint(point)).toBe(true);
    rock.vanish();
    expect(body.tiePoint(point)).toBe(false);
  });
});

describe("where rocks are", () => {
  const SEED = 1337;
  const gen = new TerrainGenerator(SEED);
  const seen = new Map<Biome, number>();
  const ids = new Set<number>();
  const out: Placement[] = [];
  for (let cz = -120; cz <= 120; cz++) {
    for (let cx = -120; cx <= 120; cx++) {
      out.length = 0;
      placeCell(gen, cx, cz, SEED, out);
      for (const p of out) {
        if (p.type !== "prop" || p.kind !== "rock") continue;
        seen.set(p.biome, (seen.get(p.biome) ?? 0) + 1);
        ids.add(p.id);
      }
    }
  }

  it("are uncommon in the plain and rare in the halloween region, and nowhere else", () => {
    const plain = seen.get(Biome.Plain) ?? 0;
    const halloween = seen.get(Biome.Halloween) ?? 0;
    expect(plain).toBeGreaterThan(20);
    expect(halloween).toBeGreaterThan(0);
    expect(seen.get(Biome.Christmas) ?? 0).toBe(0);
    expect(BIOME_SHEET[Biome.Plain].spawns.find((e) => e.kind === "rock")?.rarity).toBe("uncommon");
    expect(BIOME_SHEET[Biome.Halloween].spawns.find((e) => e.kind === "rock")?.rarity).toBe("rare");
    expect(PROP_METRICS.rock.dynamic).toBe(true);
  });

  it("each have their own id", () => {
    expect(ids.size).toBe((seen.get(Biome.Plain) ?? 0) + (seen.get(Biome.Halloween) ?? 0));
  });
});
