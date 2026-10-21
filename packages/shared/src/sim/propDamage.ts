import type { Trunk } from "../items/snowball.ts";
import { PROP_METRICS, PROP_SECTIONS, type PropKind, type PropSection } from "../worldgen/props.ts";
import type { YawBox } from "./sceneQuery.ts";
import type { Prop } from "./world.ts";

/**
 * Props that are hit and come apart (snowmen, gingerbread houses), as opposed
 * to props that are scraped for resources (a snowbank) or opened (a present).
 *
 * The parts of a snowman are `PROP_SECTIONS` (worldgen/props.ts): stacked
 * spheres, bottom first. A hit lands on one by its height; it takes damage
 * until it breaks, and takes the parts above it with it. `World.damageProp`
 * does the bookkeeping; this file is the geometry and the damage numbers.
 * A breakable prop (a gingerbread house, `PropMetrics.breakable`) has one
 * health bar for the whole of it and explodes when it is spent
 * (`World.damageBreakable`); the damage numbers below are the same.
 */

/** What each kind of blow does, in hits. A section's `hits` is how many it takes. */
export const PROP_DAMAGE = {
  /** A swing with empty hands, or with a stick like a sword. */
  chup: 1,
  /** One scoop of the hands. */
  scoop: 1,
  /** A thrown stick landing. */
  stick: 1,
  /** A thrown ball of snow bursting on it. */
  snowball: 0.5,
  /** A rock thrown or kicked hard enough to hurt. */
  rock: 3,
  /** A carton of eggnog thrown or kicked hard enough to hurt. */
  eggnog: 1,
} as const;

export type PropDamageSource = keyof typeof PROP_DAMAGE;

/** A ball slower than this (m/s) only leans on a prop; it does not hit it. */
export const HIT_SPEED = 3;

export function sectionsOf(kind: PropKind): readonly PropSection[] | undefined {
  return PROP_SECTIONS[kind];
}

/** Whether blows on this kind of prop do anything: it is made of balls or of walls. */
export function isBreakable(kind: PropKind): boolean {
  return PROP_SECTIONS[kind] !== undefined || PROP_METRICS[kind].breakable !== undefined;
}

/** How many sections of the prop are still standing (they stand from the ground up). */
export function standingSections(prop: Prop, sections: readonly PropSection[]): number {
  let count = 0;
  while (count < sections.length && (prop.broken & (1 << count)) === 0) count++;
  return count;
}

/** The world-space sphere of section `index`. */
export function sectionSphere(
  prop: Prop,
  section: PropSection,
  out: { x: number; y: number; z: number; radius: number },
): void {
  out.x = prop.x;
  out.y = prop.y + section.centre * prop.scale;
  out.z = prop.z;
  out.radius = section.radius * prop.scale;
}

/**
 * The standing section a blow at world height `y` lands on: the one whose
 * height range holds it, or the highest still standing if that part is gone.
 * -1 if the prop is not made of sections or nothing is left of it.
 */
export function sectionAtHeight(prop: Prop, y: number): number {
  const sections = sectionsOf(prop.kind);
  if (sections === undefined) return -1;
  const standing = standingSections(prop, sections);
  if (standing === 0) return -1;
  const units = (y - prop.y) / prop.scale;
  for (let i = 0; i < standing; i++) {
    if (units <= (sections[i] as PropSection).top) return i;
  }
  return standing - 1;
}

/**
 * The standing section (or, for a building, wall) a ball of `radius` at
 * (x, y, z) is touching, or -1.
 * A little slack, since a moving ball is stopped by the prop's collider a
 * hair before it reaches the sphere.
 */
export function sectionTouching(prop: Prop, x: number, y: number, z: number, radius: number): number {
  const breakable = PROP_METRICS[prop.kind].breakable;
  if (breakable !== undefined) {
    // Touching the box it is solid as (0 stands for "the whole of it").
    const local = boxLocal(prop, x, z);
    const reach = radius + 0.15;
    const inX = Math.abs(local.x) <= breakable.halfX * prop.scale + reach;
    const inZ = Math.abs(local.z) <= breakable.halfZ * prop.scale + reach;
    const inY = y >= prop.y - reach && y <= prop.y + breakable.height * prop.scale + reach;
    return inX && inZ && inY ? 0 : -1;
  }
  const sections = sectionsOf(prop.kind);
  if (sections === undefined) return -1;
  const standing = standingSections(prop, sections);
  for (let i = standing - 1; i >= 0; i--) {
    const section = sections[i] as PropSection;
    const reach = section.radius * prop.scale + radius + 0.15;
    const dx = x - prop.x;
    const dy = y - (prop.y + section.centre * prop.scale);
    const dz = z - prop.z;
    if (dx * dx + dy * dy + dz * dz <= reach * reach) return i;
  }
  return -1;
}

/** How much of a ball's height a section's collider covers, either side of its middle. */
const COLLIDER_HALF_HEIGHT = 0.6;
/** And how wide it is, as a fraction of the ball's radius: the width of a sphere at that height. */
const COLLIDER_WIDTH = 0.8;

/**
 * Pushes one solid cylinder per standing section onto `out`, so a snowman can
 * be walked into, rolled against and bounced off the way a trunk can. A sphere
 * is not a cylinder, so each is a squat one at the sphere's waist; the bottom
 * one goes down to the ground.
 */
export function propColliders(prop: Prop, out: Trunk[]): void {
  const breakable = PROP_METRICS[prop.kind].breakable;
  if (breakable !== undefined) {
    // A house is a box to the player (`propBox`); to rolling snow and ropes it is the round that fits inside.
    out.push({
      x: prop.x,
      z: prop.z,
      y0: prop.y,
      y1: prop.y + breakable.height * prop.scale,
      radius: Math.min(breakable.halfX, breakable.halfZ) * prop.scale,
    });
    return;
  }
  const sections = sectionsOf(prop.kind);
  if (sections === undefined) return;
  const standing = standingSections(prop, sections);
  for (let i = 0; i < standing; i++) {
    const section = sections[i] as PropSection;
    const radius = section.radius * prop.scale;
    const centre = prop.y + section.centre * prop.scale;
    out.push({
      x: prop.x,
      z: prop.z,
      y0: i === 0 ? prop.y : centre - radius * COLLIDER_HALF_HEIGHT,
      y1: centre + radius * COLLIDER_HALF_HEIGHT,
      radius: radius * COLLIDER_WIDTH,
    });
  }
}

const boxPoint = { x: 0, z: 0 };

/** A world (x, z) in a prop's own frame, metres from its middle (three's Y rotation, undone). */
function boxLocal(prop: Prop, x: number, z: number): { x: number; z: number } {
  const dx = x - prop.x;
  const dz = z - prop.z;
  const cos = Math.cos(prop.yaw);
  const sin = Math.sin(prop.yaw);
  boxPoint.x = dx * cos - dz * sin;
  boxPoint.z = dx * sin + dz * cos;
  return boxPoint;
}

/**
 * Pushes the box a breakable prop (a house) is solid as, for the player to be
 * stopped by. Nothing for a prop that is not breakable.
 */
export function propBox(prop: Prop, out: YawBox[]): void {
  const breakable = PROP_METRICS[prop.kind].breakable;
  if (breakable === undefined) return;
  const half = (breakable.height * prop.scale) / 2;
  out.push({
    x: prop.x,
    y: prop.y + half,
    z: prop.z,
    halfX: breakable.halfX * prop.scale,
    halfY: half,
    halfZ: breakable.halfZ * prop.scale,
    cos: Math.cos(prop.yaw),
    sin: Math.sin(prop.yaw),
  });
}
