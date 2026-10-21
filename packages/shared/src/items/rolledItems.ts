import { ItemType } from "./inventory.ts";
import { ROCK_RADIUS, STONE } from "./rock.ts";
import { SnowballField, type RollMaterial, type Snowball } from "./snowball.ts";

/**
 * Items that are used the way a rock is: held in the fist, let go of with left
 * mouse to roll along the ground and with right mouse to be put overhand, and
 * once let go a heavy ball in the same field a snowball is (see items/rock.ts
 * for what that gives it), to be picked up again with E.
 *
 * A rock and a carton of eggnog are the two so far; they differ only in what
 * they weigh, how they bounce, and what they look like. Adding another is a row
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

export interface RolledItem {
  readonly item: ItemType;
  readonly material: RollMaterial;
  /** Radius of a standard one, metres. */
  readonly radius: number;
}

export const ROLLED_ITEMS: readonly RolledItem[] = [
  { item: ItemType.Rock, material: STONE, radius: ROCK_RADIUS },
  { item: ItemType.Eggnog, material: CARTON, radius: CARTON_RADIUS },
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
