import { SnowballField, type RollMaterial, type Snowball } from "./snowball.ts";

/**
 * Rocks. A rock is a heavy ball in the same field a snowball is, with a
 * different {@link RollMaterial}: it weighs what a rock does, does not pick up
 * snow, comes to rest on a slope, bounces a little, and is not forgotten when
 * nobody is near. So everything that holds for a rolled snowball holds for it:
 * walkers shove it (and are slowed by its weight), it rolls into other balls
 * and shoves them by weight, a rope can be tied to it and pull it, a swing can
 * knock it. Held, it is used exactly as a snowball is (see `ItemType.Rock`):
 * rolled along the ground with left mouse, put overhand with right.
 *
 * The world scatters them (`PlacedRock`, from the generation sheet) lying
 * still; they stay where they are until something moves them.
 */

/** Radius of a standard rock, metres. rock.glb is about 40cm across; this sits inside it. */
export const ROCK_RADIUS = 0.17;

/**
 * Stone, as a game rock: 1200 kg/m^3 makes a standard rock about 25kg, heavy
 * enough to be an effort to shove and to stay put when bumped, light enough
 * to be picked up and thrown. (Real stone is twice that.)
 */
export const STONE: RollMaterial = {
  density: 1200,
  drag: 6,
  restSlope: 0.6,
  bounce: 0.3,
  grows: false,
  heavy: true,
};

/** Whether a rolled thing is a rock. */
export function isRock(ball: Snowball): boolean {
  return ball.material === STONE;
}

/** A rock lying where the world put it, `scale` times a standard rock, at rest. */
export function placeRock(
  field: SnowballField,
  worldId: number,
  x: number,
  groundY: number,
  z: number,
  scale: number,
): Snowball {
  const radius = ROCK_RADIUS * scale;
  const rock = field.spawn(x, groundY + radius, z, 0, 0, 0, radius, STONE);
  rock.worldId = worldId;
  rock.settle();
  return rock;
}

/** A standard rock let go with a velocity: rolled along the ground, or put through the air. */
export function spawnRock(
  field: SnowballField,
  x: number,
  y: number,
  z: number,
  vx: number,
  vy: number,
  vz: number,
): Snowball {
  return field.spawn(x, y, z, vx, vy, vz, ROCK_RADIUS, STONE);
}
