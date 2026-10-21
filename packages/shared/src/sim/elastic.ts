/**
 * Elasticity, for anything that stretches and snaps back: the xmas lights
 * now, a bungee, a rubber band, a bouncy mat later. Two pieces, and neither
 * knows what a rope is.
 *
 * - {@link ElasticMaterial} and {@link elasticForce}: how hard a stretched
 *   piece pulls back. A spring, until it is stretched to its "max elastic",
 *   past which it stops giving and goes hard.
 * - {@link ElasticCollider}: a moving thing (a player, later a snowball or an
 *   animal) that elastic things are pushed out of, and that they push back
 *   on. The elastic thing finds the shortest way out of the shape, stretches
 *   itself round it, and hands the thing the force it is stretched with as an
 *   impulse: so a string walked into stretches, then throws you back, with as
 *   much speed as it was stretched far.
 *
 * Lives in shared (no DOM, no three.js): the server will run it.
 */

export interface ElasticVec {
  x: number;
  y: number;
  z: number;
}

export interface ElasticMaterial {
  /** Newtons per metre of stretch, for a whole piece of it. */
  readonly stiffness: number;
  /**
   * The "max elastic": how far it stretches before it stops giving, as a
   * fraction of its length (0.5: half as long again). Past it the piece is
   * {@link HARDENING} times as stiff, a wall more than a spring.
   */
  readonly maxStrain: number;
  /** Most force it ever pulls or pushes anything with, newtons. */
  readonly maxForce: number;
}

/** How many times stiffer a piece gets once it is stretched past its max strain. */
export const HARDENING = 12;

/**
 * The force, in newtons, a piece of `restLength` pulls back with when it is
 * `stretch` metres longer than that. Zero when it is not stretched: elastic
 * pulls, never pushes. `material.stiffness` is the stiffness of a piece this
 * long; not capped (callers cap with `maxForce` where it applies).
 */
export function elasticForce(
  material: ElasticMaterial,
  restLength: number,
  stretch: number,
): number {
  if (stretch <= 0) return 0;
  const limit = material.maxStrain * restLength;
  if (stretch <= limit) return material.stiffness * stretch;
  return material.stiffness * (limit + HARDENING * (stretch - limit));
}

/** A sphere that is a quick bound on a collider: anything farther than this from it cannot touch it. */
export interface ElasticBounds {
  x: number;
  y: number;
  z: number;
  radius: number;
}

/**
 * A moving thing elastic pieces collide with. Implemented by whoever owns the
 * thing (see `PlayerBody`), over its own state, so the elastic code never
 * needs to know what it is.
 */
export interface ElasticCollider {
  /** Kilograms. */
  readonly mass: number;
  /** Where it is, roughly; false when it is not in play (dead, out of the world). */
  bounds(out: ElasticBounds): boolean;
  /**
   * If a particle of `radius` at (x, y, z) overlaps the shape, writes into
   * `out` the shortest move that clears it and returns true. See
   * {@link boxPushOut} and {@link spherePushOut}.
   */
  pushOut(x: number, y: number, z: number, radius: number, out: ElasticVec): boolean;
  /** How fast it is moving, m/s. */
  velocity(out: ElasticVec): void;
  /** An impulse (N*s) on it: the elastic thing pushing back. */
  push(ix: number, iy: number, iz: number): void;
}

/** The top face of a box is a poor way out unless the particle is nearly through it: otherwise stay out to the side. */
const TOP_FACE_BIAS = 6;

/**
 * Shortest move that takes a particle of `radius` at (x, y, z) out of the box
 * `min..max`. Out of the sides, or over the top when it is almost through
 * it; never down, which would drive it into the ground the box stands on.
 */
export function boxPushOut(
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: ElasticVec,
): boolean {
  if (
    x <= minX - radius ||
    x >= maxX + radius ||
    z <= minZ - radius ||
    z >= maxZ + radius ||
    y <= minY - radius ||
    y >= maxY + radius
  ) {
    return false;
  }
  const left = x - (minX - radius);
  const right = maxX + radius - x;
  const back = z - (minZ - radius);
  const front = maxZ + radius - z;
  const top = (maxY + radius - y) * TOP_FACE_BIAS;
  let best = left;
  out.x = -left;
  out.y = 0;
  out.z = 0;
  if (right < best) {
    best = right;
    out.x = right;
  }
  if (back < best) {
    best = back;
    out.x = 0;
    out.z = -back;
  }
  if (front < best) {
    best = front;
    out.x = 0;
    out.z = front;
  }
  if (top < best) {
    out.x = 0;
    out.z = 0;
    out.y = maxY + radius - y;
  }
  return true;
}

/**
 * Shortest move that takes a particle of `radius` at (x, y, z) out of the
 * sphere at (cx, cy, cz). A particle below the centre is moved out sideways
 * rather than down, for the same reason as {@link boxPushOut}.
 */
export function spherePushOut(
  cx: number,
  cy: number,
  cz: number,
  sphereRadius: number,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: ElasticVec,
): boolean {
  const reach = sphereRadius + radius;
  const dx = x - cx;
  const dy = y - cy;
  const dz = z - cz;
  const distSq = dx * dx + dy * dy + dz * dz;
  if (distSq >= reach * reach) return false;
  const dist = Math.sqrt(distSq);
  const flat = Math.hypot(dx, dz);
  if (dy < -0.5 * dist || dist < 1e-9) {
    // Below the middle: slide out along the ground to where the sphere is `reach` wide at this height.
    const half = Math.sqrt(Math.max(0, reach * reach - dy * dy));
    const nx = flat > 1e-9 ? dx / flat : 1;
    const nz = flat > 1e-9 ? dz / flat : 0;
    out.x = nx * (half - flat);
    out.y = 0;
    out.z = nz * (half - flat);
    return true;
  }
  const k = (reach - dist) / dist;
  out.x = dx * k;
  out.y = dy * k;
  out.z = dz * k;
  return true;
}
