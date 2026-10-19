import { VOXEL_SIZE } from "./constants.ts";

/**
 * Voxel collision. A near-verbatim port of src/voxel/Collision.cpp --
 * every epsilon, every bias, every iteration count is deliberate and
 * matches the reference implementation.
 *
 * The one structural change is {@link SolidQuery}. The C++ calls
 * `world.isSolidIncludingSnappedLogs()` directly, which hardcodes the
 * stopgap that only lets a felled log be walked on if it happened to land
 * square with the voxel grid (see that function's comment in World.hpp --
 * it is explicit that the mechanism should be replaced, not extended).
 * Routing every solidity test through one interface means M8 can supply a
 * query that handles arbitrarily-oriented bodies without touching any of the
 * sweep maths below.
 *
 * Everything here is written against scalars rather than a vector type and
 * writes into caller-provided result objects. Collision runs up to 8 times
 * per frame at 120Hz and each sweep touches a few hundred voxels; a vector
 * class allocating temporaries per operation would make this the single
 * largest source of garbage in the game.
 */

export interface SolidQuery {
  /** True if the voxel at these *world voxel* coordinates blocks movement. */
  isSolid(vx: number, vy: number, vz: number): boolean;
}

const EPSILON = 1e-4;

/** Matches the C++ kProbeDistance in sweepAabb. */
const PROBE_DISTANCE = 0.05;

export interface AabbCollision {
  /** Resolved position (bottom-centre / feet). */
  x: number;
  y: number;
  z: number;
  /** Input velocity with blocked axes zeroed. */
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

export interface SphereCollision {
  /** Resolved centre. */
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  grounded: boolean;
}

export function createAabbCollision(): AabbCollision {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
}

export function createSphereCollision(): SphereCollision {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, grounded: false };
}

// Scratch for sweepBoxAxis's indexed-axis arithmetic. Safe to share: the
// function neither recurses nor calls anything that reaches back into it.
const sweptMin = [0, 0, 0];
const sweptMax = [0, 0, 0];
const boxMin = [0, 0, 0];
const boxMax = [0, 0, 0];
const voxelMin = [0, 0, 0];
const voxelMax = [0, 0, 0];

/**
 * Sweeps the box [min, max] along one axis by `delta` (either sign),
 * returning the largest movement in the same direction that does not push
 * the box into a solid voxel.
 */
function sweepBoxAxis(
  query: SolidQuery,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  axis: number,
  delta: number,
): number {
  if (delta === 0) return 0;

  boxMin[0] = minX;
  boxMin[1] = minY;
  boxMin[2] = minZ;
  boxMax[0] = maxX;
  boxMax[1] = maxY;
  boxMax[2] = maxZ;

  sweptMin[0] = minX;
  sweptMin[1] = minY;
  sweptMin[2] = minZ;
  sweptMax[0] = maxX;
  sweptMax[1] = maxY;
  sweptMax[2] = maxZ;
  if (delta > 0) {
    sweptMax[axis] = (sweptMax[axis] ?? 0) + delta;
  } else {
    sweptMin[axis] = (sweptMin[axis] ?? 0) + delta;
  }

  const otherA = (axis + 1) % 3;
  const otherB = (axis + 2) % 3;

  // Bias the bounds inward by EPSILON before floor/ceil: a resting position
  // is expected to sit exactly on a voxel boundary (feet flush on a ground
  // layer's top face), but repeated float accumulation (step-up lifts,
  // gravity integration) drifts it a hair below the true value. Un-biased
  // floor/ceil then pulls in one extra voxel layer that is actually behind
  // the box's own edge -- for an upward sweep that means the ground the box
  // is standing on gets scanned as if it were a ceiling ahead, clamping all
  // upward movement (jump, step-up headroom) to zero.
  const voxMinX = Math.floor(((sweptMin[0] ?? 0) + EPSILON) / VOXEL_SIZE);
  const voxMinY = Math.floor(((sweptMin[1] ?? 0) + EPSILON) / VOXEL_SIZE);
  const voxMinZ = Math.floor(((sweptMin[2] ?? 0) + EPSILON) / VOXEL_SIZE);
  const voxMaxX = Math.ceil(((sweptMax[0] ?? 0) - EPSILON) / VOXEL_SIZE) - 1;
  const voxMaxY = Math.ceil(((sweptMax[1] ?? 0) - EPSILON) / VOXEL_SIZE) - 1;
  const voxMaxZ = Math.ceil(((sweptMax[2] ?? 0) - EPSILON) / VOXEL_SIZE) - 1;

  let allowed = delta;

  for (let x = voxMinX; x <= voxMaxX; x++) {
    for (let y = voxMinY; y <= voxMaxY; y++) {
      for (let z = voxMinZ; z <= voxMaxZ; z++) {
        if (!query.isSolid(x, y, z)) continue;

        voxelMin[0] = x * VOXEL_SIZE;
        voxelMin[1] = y * VOXEL_SIZE;
        voxelMin[2] = z * VOXEL_SIZE;
        voxelMax[0] = voxelMin[0] + VOXEL_SIZE;
        voxelMax[1] = voxelMin[1] + VOXEL_SIZE;
        voxelMax[2] = voxelMin[2] + VOXEL_SIZE;

        // Only voxels overlapping the box on both non-swept axes can block
        // movement along this axis.
        if (
          (voxelMax[otherA] ?? 0) <= (boxMin[otherA] ?? 0) + EPSILON ||
          (voxelMin[otherA] ?? 0) >= (boxMax[otherA] ?? 0) - EPSILON
        ) {
          continue;
        }
        if (
          (voxelMax[otherB] ?? 0) <= (boxMin[otherB] ?? 0) + EPSILON ||
          (voxelMin[otherB] ?? 0) >= (boxMax[otherB] ?? 0) - EPSILON
        ) {
          continue;
        }

        if (delta > 0) {
          const maxAllowed = (voxelMin[axis] ?? 0) - (boxMax[axis] ?? 0);
          if (maxAllowed < allowed) allowed = Math.max(0, maxAllowed);
        } else {
          const maxAllowed = (voxelMax[axis] ?? 0) - (boxMin[axis] ?? 0);
          if (maxAllowed > allowed) allowed = Math.min(0, maxAllowed);
        }
      }
    }
  }

  return allowed;
}

/** Can the box at these feet fall any further? */
function probeGrounded(
  query: SolidQuery,
  feetX: number,
  feetY: number,
  feetZ: number,
  halfWidth: number,
  height: number,
): boolean {
  const probe = sweepBoxAxis(
    query,
    feetX - halfWidth,
    feetY,
    feetZ - halfWidth,
    feetX + halfWidth,
    feetY + height,
    feetZ + halfWidth,
    1,
    -PROBE_DISTANCE,
  );
  return probe > -PROBE_DISTANCE + EPSILON;
}

/**
 * Sweeps an axis-aligned box through the world by velocity * dt, resolving
 * axis-by-axis (Y first, then X, then Z) so the box never ends up
 * penetrating a solid voxel.
 *
 * `position` is the box's bottom-centre (feet); halfWidth/height describe a
 * box of size (2*halfWidth, height, 2*halfWidth) centred horizontally on it.
 * If horizontal movement is blocked while grounded, step-up attempts are
 * made up to stepHeight -- a 10cm heightmap produces single-voxel ledges
 * everywhere, and without the assist a walking player stops dead at each one.
 */
export function sweepAabb(
  query: SolidQuery,
  posX: number,
  posY: number,
  posZ: number,
  halfWidth: number,
  height: number,
  velX: number,
  velY: number,
  velZ: number,
  dt: number,
  stepHeight: number,
  out: AabbCollision,
): AabbCollision {
  let px = posX;
  let py = posY;
  let pz = posZ;
  let vx = velX;
  let vy = velY;
  let vz = velZ;

  // Grounded probe taken BEFORE the Y sweep, purely to gate the step-up
  // assist below. A jump impulse this same call can move the box up more
  // than the probe distance in a single substep (6.3 m/s / 120Hz = 0.0525m
  // > 0.05m), which would make the post-sweep probe read airborne on the
  // very frame Space was pressed -- skipping the step-up assist and zeroing
  // vx against the ledge instead of lifting onto it. Whether the box was on
  // solid ground an instant ago does not depend on this frame's jump.
  const groundedAtEntry = probeGrounded(query, px, py, pz, halfWidth, height);

  // Y axis first (gravity / ground) so the horizontal sweeps below see an
  // already-settled height.
  {
    const requested = vy * dt;
    const dy = sweepBoxAxis(
      query,
      px - halfWidth,
      py,
      pz - halfWidth,
      px + halfWidth,
      py + height,
      pz + halfWidth,
      1,
      requested,
    );
    py += dy;
    if (Math.abs(dy - requested) > EPSILON) vy = 0;
  }

  // The value callers see (Player's grounded for next frame's jump and
  // air-accel decisions).
  const grounded = probeGrounded(query, px, py, pz, halfWidth, height);

  const dxRequested = vx * dt;
  const dzRequested = vz * dt;

  const dxAllowed = sweepBoxAxis(
    query,
    px - halfWidth,
    py,
    pz - halfWidth,
    px + halfWidth,
    py + height,
    pz + halfWidth,
    0,
    dxRequested,
  );
  const dzAllowed = sweepBoxAxis(
    query,
    px + dxAllowed - halfWidth,
    py,
    pz - halfWidth,
    px + dxAllowed + halfWidth,
    py + height,
    pz + halfWidth,
    2,
    dzRequested,
  );

  const xBlocked = Math.abs(dxAllowed - dxRequested) > EPSILON;
  const zBlocked = Math.abs(dzAllowed - dzRequested) > EPSILON;

  // Try the horizontal move again from progressively higher lifts (starting
  // at exactly one voxel, the common case) rather than only ever attempting
  // the full stepHeight in one go -- a single big lift can fail (a second
  // bump just beyond reach at that height) where a smaller, exact-fit lift
  // would have cleared. Commits to the first lift height that makes
  // progress on every axis that was blocked at ground level without newly
  // blocking one that was not: diagonal approaches have both dx and dz
  // nonzero almost always, so requiring *both* to fully clear made this
  // misfire on anything but a dead-on approach.
  if (groundedAtEntry && stepHeight > 0 && (xBlocked || zBlocked)) {
    for (let lift = VOXEL_SIZE; lift <= stepHeight + EPSILON; lift += VOXEL_SIZE) {
      const headroom = sweepBoxAxis(
        query,
        px - halfWidth,
        py,
        pz - halfWidth,
        px + halfWidth,
        py + height,
        pz + halfWidth,
        1,
        lift,
      );
      if (headroom < lift - EPSILON) break; // no clearance here, none higher either

      const liftedY = py + lift;
      const liftedDx = sweepBoxAxis(
        query,
        px - halfWidth,
        liftedY,
        pz - halfWidth,
        px + halfWidth,
        liftedY + height,
        pz + halfWidth,
        0,
        dxRequested,
      );
      const afterX = px + liftedDx;
      const liftedDz = sweepBoxAxis(
        query,
        afterX - halfWidth,
        liftedY,
        pz - halfWidth,
        afterX + halfWidth,
        liftedY + height,
        pz + halfWidth,
        2,
        dzRequested,
      );

      const liftedXBlocked = Math.abs(liftedDx - dxRequested) > EPSILON;
      const liftedZBlocked = Math.abs(liftedDz - dzRequested) > EPSILON;
      if ((!xBlocked || !liftedXBlocked) && (!zBlocked || !liftedZBlocked)) {
        const settledX = afterX;
        const settledZ = pz + liftedDz;
        const drop = sweepBoxAxis(
          query,
          settledX - halfWidth,
          liftedY,
          settledZ - halfWidth,
          settledX + halfWidth,
          liftedY + height,
          settledZ + halfWidth,
          1,
          -lift,
        );
        out.x = settledX;
        out.y = liftedY + drop;
        out.z = settledZ;
        out.vx = vx;
        out.vy = vy;
        out.vz = vz;
        out.grounded = true;
        return out;
      }
    }
  }

  px += dxAllowed;
  pz += dzAllowed;
  if (xBlocked) vx = 0;
  if (zBlocked) vz = 0;

  out.x = px;
  out.y = py;
  out.z = pz;
  out.vx = vx;
  out.vy = vy;
  out.vz = vz;
  out.grounded = grounded;
  return out;
}

/** Penetration-resolution passes in sweepSphere. Matches the C++ kIterations. */
const SPHERE_ITERATIONS = 4;

/**
 * Sweeps a sphere through the world by velocity * dt.
 *
 * Movement is applied in full, then penetration against nearby solid voxels
 * is resolved iteratively (closest-point-on-box push-out), so simultaneous
 * contacts -- corners, grooves -- settle out over a few passes rather than
 * only ever resolving the single deepest one. The velocity component
 * pointing into each contact normal is removed (slide response), which is
 * what lets a rolling ball keep momentum along a slope instead of stopping
 * dead on contact.
 */
export function sweepSphere(
  query: SolidQuery,
  posX: number,
  posY: number,
  posZ: number,
  radius: number,
  velX: number,
  velY: number,
  velZ: number,
  dt: number,
  out: SphereCollision,
): SphereCollision {
  let px = posX + velX * dt;
  let py = posY + velY * dt;
  let pz = posZ + velZ * dt;
  let vx = velX;
  let vy = velY;
  let vz = velZ;
  let grounded = false;

  for (let iter = 0; iter < SPHERE_ITERATIONS; iter++) {
    // Biased inward by EPSILON before floor(), same reasoning as
    // sweepBoxAxis above.
    const voxMinX = Math.floor((px - radius + EPSILON) / VOXEL_SIZE);
    const voxMinY = Math.floor((py - radius + EPSILON) / VOXEL_SIZE);
    const voxMinZ = Math.floor((pz - radius + EPSILON) / VOXEL_SIZE);
    const voxMaxX = Math.floor((px + radius - EPSILON) / VOXEL_SIZE);
    const voxMaxY = Math.floor((py + radius - EPSILON) / VOXEL_SIZE);
    const voxMaxZ = Math.floor((pz + radius - EPSILON) / VOXEL_SIZE);

    let anyPenetration = false;
    for (let x = voxMinX; x <= voxMaxX; x++) {
      for (let y = voxMinY; y <= voxMaxY; y++) {
        for (let z = voxMinZ; z <= voxMaxZ; z++) {
          if (!query.isSolid(x, y, z)) continue;

          const vMinX = x * VOXEL_SIZE;
          const vMinY = y * VOXEL_SIZE;
          const vMinZ = z * VOXEL_SIZE;
          const closestX = Math.min(Math.max(px, vMinX), vMinX + VOXEL_SIZE);
          const closestY = Math.min(Math.max(py, vMinY), vMinY + VOXEL_SIZE);
          const closestZ = Math.min(Math.max(pz, vMinZ), vMinZ + VOXEL_SIZE);

          const toX = px - closestX;
          const toY = py - closestY;
          const toZ = pz - closestZ;
          const dist = Math.hypot(toX, toY, toZ);
          if (dist >= radius || dist < 1e-6) continue;

          const nx = toX / dist;
          const ny = toY / dist;
          const nz = toZ / dist;
          const penetration = radius - dist;
          px += nx * penetration;
          py += ny * penetration;
          pz += nz * penetration;

          // Slide response: drop only the velocity component pointing into
          // the surface, so a rolling ball keeps momentum along the tangent.
          const intoSurface = vx * nx + vy * ny + vz * nz;
          if (intoSurface < 0) {
            vx -= nx * intoSurface;
            vy -= ny * intoSurface;
            vz -= nz * intoSurface;
          }
          if (ny > 0.5) grounded = true;
          anyPenetration = true;
        }
      }
    }

    if (!anyPenetration) break;
  }

  out.x = px;
  out.y = py;
  out.z = pz;
  out.vx = vx;
  out.vy = vy;
  out.vz = vz;
  out.grounded = grounded;
  return out;
}

/**
 * True if any solid voxel overlaps [min, max].
 *
 * Unlike the sweeps above, which only ever prevent *new* penetration from
 * motion, this checks a box's current resting state -- needed when a
 * collider changes shape discontinuously (Ragball's sphere swapping for
 * Walking's taller box at the same feet position) and might already be
 * embedded in terrain no sweep ever had a chance to stop.
 */
export function aabbOverlapsSolid(
  query: SolidQuery,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const voxMinX = Math.floor((minX + EPSILON) / VOXEL_SIZE);
  const voxMinY = Math.floor((minY + EPSILON) / VOXEL_SIZE);
  const voxMinZ = Math.floor((minZ + EPSILON) / VOXEL_SIZE);
  const voxMaxX = Math.ceil((maxX - EPSILON) / VOXEL_SIZE) - 1;
  const voxMaxY = Math.ceil((maxY - EPSILON) / VOXEL_SIZE) - 1;
  const voxMaxZ = Math.ceil((maxZ - EPSILON) / VOXEL_SIZE) - 1;

  for (let x = voxMinX; x <= voxMaxX; x++) {
    for (let y = voxMinY; y <= voxMaxY; y++) {
      for (let z = voxMinZ; z <= voxMaxZ; z++) {
        if (query.isSolid(x, y, z)) return true;
      }
    }
  }
  return false;
}
