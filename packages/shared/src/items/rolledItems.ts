import { ItemType } from "./inventory.ts";
import { ROCK_RADIUS, STONE } from "./rock.ts";
import { SnowballField, type RollMaterial, type Snowball } from "./snowball.ts";

/**
 * Items that are used the way a rock is: held in the fist, let go of with left
 * mouse to roll along the ground and with right mouse to be put overhand, and
 * once let go a heavy ball in the same field a snowball is (see items/rock.ts
 * for what that gives it), to be picked up again with E.
 *
 * A rock, a carton of eggnog and a roll of toilet paper are the three so far; they differ
 * only in what they weigh, how they bounce, and what they look like. Adding another is a row
 * in {@link ROLLED_ITEMS} and a mesh in the client.
 */

/** Radius of a rolled carton of eggnog, metres: it is drawn 24cm tall and 7cm across, and rolls as a ball this big. */
export const CARTON_RADIUS = 0.1;

/**
 * A carton, as a game ball: about a kilogram, so a walker shoves it aside
 * without noticing, and it hops a little more than a rock when it lands.
 */
export const CARTON: RollMaterial = {
  density: 250,
  drag: 6,
  restSlope: 0.6,
  bounce: 0.2,
  grows: false,
  heavy: true,
};

/** Radius of a rolled toilet paper, metres: the roll is drawn about 16cm across. */
export const TOILET_PAPER_RADIUS = 0.08;

/**
 * A roll of toilet paper, as a game ball: next to no weight, so a walker pushes it along
 * without noticing, but it is all air and cardboard, so it is slowed hard by the ground (a good bowl
 * goes a couple of metres) and hops a little when it lands. It is also thrown at half the speed of
 * a rock ({@link RolledItem.speedScale}).
 */
export const TOILET_PAPER: RollMaterial = {
  density: 60,
  drag: 4,
  restSlope: 0.4,
  bounce: 0.3,
  grows: false,
  heavy: true,
};

export interface RolledItem {
  readonly item: ItemType;
  readonly material: RollMaterial;
  /** Radius of a standard one, metres. */
  readonly radius: number;
  /** How fast it leaves the hand, as a share of what a rock would: a light thing does not go as far. Default 1. */
  readonly speedScale?: number;
}

export const ROLLED_ITEMS: readonly RolledItem[] = [
  { item: ItemType.Rock, material: STONE, radius: ROCK_RADIUS },
  { item: ItemType.Eggnog, material: CARTON, radius: CARTON_RADIUS },
  { item: ItemType.ToiletPaper, material: TOILET_PAPER, radius: TOILET_PAPER_RADIUS, speedScale: 0.5 },
];

/** The rolled-item row for an item held in the hand, if it is used like a rock. */
export function rolledItemOf(item: ItemType | undefined): RolledItem | undefined {
  return ROLLED_ITEMS.find((row) => row.item === item);
}

/** Which item a ball on the ground is, if it is one of these (not snow). */
export function itemOfBall(ball: Snowball): ItemType | undefined {
  for (const row of ROLLED_ITEMS) if (row.material === ball.material) return row.item;
  return undefined;
}

/** A standard one of `row` let go with a velocity: rolled along the ground, or put through the air. */
export function spawnRolled(
  field: SnowballField,
  row: RolledItem,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
): Snowball {
  return field.spawn(x, y, z, vx, vy, vz, row.radius, row.material);
}
