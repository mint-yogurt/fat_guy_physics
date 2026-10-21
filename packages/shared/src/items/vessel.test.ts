import { describe, expect, it } from "vitest";

import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { ITEM_NAMES, ItemType, itemTypeFromName } from "./inventory.ts";
import { CARTON, CARTON_RADIUS, itemOfBall, rolledItemOf, spawnRolled } from "./rolledItems.ts";
import { ROCK_RADIUS, STONE } from "./rock.ts";
import { SnowballField } from "./snowball.ts";
import {
  burstSpeedAt,
  putSpeedAt,
  Shake,
  SHAKE_FILL_SECONDS,
  splashAt,
  stainAt,
  ThrownVessels,
  vesselOf,
  VESSELS,
} from "./vessel.ts";

const DT = 1 / 120;
/** Solid below y = 1, everywhere. */
const floor: SolidQuery = { isSolid: (_vx, vy) => (vy + 0.5) * VOXEL_SIZE < 1 };

const can = vesselOf(ItemType.MountainLightning)!;
const goo = vesselOf(ItemType.Goo)!;

function fly(vessels: ThrownVessels, seconds: number): void {
  for (let i = 0; i < seconds / DT; i++) vessels.step(DT, floor);
}

describe("the new items", () => {
  it("are named as the generation sheet names them", () => {
    for (const name of ["mountain_lightning", "eggnog", "coal", "goo"]) {
      const type = itemTypeFromName(name);
      expect(type).toBeDefined();
      expect(ITEM_NAMES[type as number]).toBe(name);
    }
    expect(ITEM_NAMES.length).toBe(Object.keys(ItemType).length);
  });
});

describe("a shaken vessel", () => {
  it("fills while the button is held, and only that long", () => {
    const shake = new Shake();
    shake.update(SHAKE_FILL_SECONDS / 2, true);
    expect(shake.level).toBeCloseTo(0.5, 6);
    shake.update(SHAKE_FILL_SECONDS * 2, true);
    expect(shake.level).toBe(1);
  });

  it("settles slowly once let go, and can be emptied", () => {
    const shake = new Shake();
    shake.update(SHAKE_FILL_SECONDS, true);
    shake.update(1, false);
    expect(shake.level).toBeLessThan(1);
    expect(shake.level).toBeGreaterThan(0.8);
    shake.reset();
    expect(shake.level).toBe(0);
  });

  it("bursts at a gentler speed, and splashes bigger", () => {
    expect(burstSpeedAt(can, 1)).toBeLessThan(burstSpeedAt(can, 0));
    expect(splashAt(can, 1)).toBeGreaterThan(splashAt(can, 0));
    expect(stainAt(goo, 1)).toBeGreaterThan(stainAt(goo, 0));
    expect(burstSpeedAt(can, 0.5)).toBeCloseTo((can.burstSpeed + can.shakenBurstSpeed) / 2, 6);
  });

  it("is thrown further by a longer charge, and goo not nearly as far as a can", () => {
    for (const spec of VESSELS) {
      expect(putSpeedAt(spec, 1)).toBeGreaterThan(putSpeedAt(spec, 0));
      expect(putSpeedAt(spec, 5)).toBe(spec.putMax);
    }
    expect(goo.putMax).toBeLessThan(can.putMax / 2);
  });
});

describe("a thrown vessel", () => {
  it("bursts on a hard hit, facing the surface it met", () => {
    const vessels = new ThrownVessels();
    vessels.throw(can, 0, 0, 3, 0, 0, -22, 0);
    fly(vessels, 1);
    expect(vessels.flying.length).toBe(0);
    expect(vessels.landings.length).toBe(0);
    const splat = vessels.splats[0]!;
    expect(splat.spec).toBe(can);
    expect(splat.ny).toBeGreaterThan(0.99);
    expect(splat.speed).toBeGreaterThan(burstSpeedAt(can, 0));
    expect(splat.y).toBeCloseTo(1 + can.radius, 1);
  });

  it("only lands on a soft one, moving off gently and still an item", () => {
    const vessels = new ThrownVessels();
    vessels.throw(can, 0, 0, 1.4, 0, 3, 0, 0);
    fly(vessels, 1);
    expect(vessels.splats.length).toBe(0);
    const landing = vessels.landings[0]!;
    expect(landing.item).toBe(ItemType.MountainLightning);
    expect(landing.vy).toBeGreaterThanOrEqual(0);
    expect(landing.vx).toBeGreaterThan(0);
  });

  it("bursts the same throw once it has been shaken", () => {
    const soft = (shake: number): "splat" | "landing" => {
      const vessels = new ThrownVessels();
      // About 9 m/s into the floor: under a fresh can's 15, over a shaken one's 5.
      vessels.throw(can, shake, 0, 2, 0, 0, -3, 0);
      fly(vessels, 1);
      return vessels.splats.length > 0 ? "splat" : "landing";
    };
    expect(soft(0)).toBe("landing");
    expect(soft(1)).toBe("splat");
  });

  it("splats goo on almost any knock, with a stain to make", () => {
    const vessels = new ThrownVessels();
    vessels.throw(goo, 0, 0, 1.6, 0, 3, 0, 0);
    fly(vessels, 1);
    expect(vessels.splats.length).toBe(1);
    expect(stainAt(goo, vessels.splats[0]!.shake)).toBeGreaterThan(0.5);
  });

  it("leaves a can with no stain to make", () => {
    expect(stainAt(can, 1)).toBe(0);
  });

  it("gives up on one that flies for ever", () => {
    const vessels = new ThrownVessels();
    vessels.throw(can, 0, 0, 100, 0, 0, 1, 0);
    for (let i = 0; i < 20 / DT; i++) {
      // Nothing to hit.
      vessels.step(DT, { isSolid: () => false });
    }
    expect(vessels.flying.length).toBe(0);
    expect(vessels.splats.length + vessels.landings.length).toBe(0);
  });
});

describe("rolled items", () => {
  it("are the rock and the carton, told apart by what they are made of", () => {
    const field = new SnowballField();
    const rock = spawnRolled(field, rolledItemOf(ItemType.Rock)!, 0, 2, 0, 0, 0, 0);
    const carton = spawnRolled(field, rolledItemOf(ItemType.Eggnog)!, 3, 2, 0, 0, 0, 0);
    const snow = field.spawn(6, 2, 0, 0, 0, 0);
    expect(itemOfBall(rock)).toBe(ItemType.Rock);
    expect(itemOfBall(carton)).toBe(ItemType.Eggnog);
    expect(itemOfBall(snow)).toBeUndefined();
    expect(rock.material).toBe(STONE);
    expect(carton.material).toBe(CARTON);
    expect(rock.radius).toBe(ROCK_RADIUS);
    expect(carton.radius).toBe(CARTON_RADIUS);
  });

  it("weigh what a carton and a rock weigh", () => {
    const field = new SnowballField();
    const rock = spawnRolled(field, rolledItemOf(ItemType.Rock)!, 0, 2, 0, 0, 0, 0);
    const carton = spawnRolled(field, rolledItemOf(ItemType.Eggnog)!, 3, 2, 0, 0, 0, 0);
    expect(carton.mass).toBeGreaterThan(0.5);
    expect(carton.mass).toBeLessThan(2);
    expect(rock.mass).toBeGreaterThan(carton.mass * 10);
  });

  it("do not include the other items", () => {
    expect(rolledItemOf(ItemType.Coal)).toBeUndefined();
    expect(rolledItemOf(ItemType.Snowball)).toBeUndefined();
    expect(rolledItemOf(undefined)).toBeUndefined();
  });
});
