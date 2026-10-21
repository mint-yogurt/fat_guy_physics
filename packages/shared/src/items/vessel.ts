import { createSphereCollision, sweepSphere, type SolidQuery } from "../sim/collision.ts";
import { ItemType } from "./inventory.ts";

/**
 * Things that burst when they are thrown hard enough: a can of mountain
 * lightning, which sprays green fizz, and a ball of goo, which splats a stain.
 *
 * Held, one is shaken with left mouse (it fills a {@link Shake} the longer the
 * button is held) and thrown with right mouse, like a snowball is put. In
 * flight it is a {@link ThrownVessels} body. What it hits it meets at some
 * speed into the surface; fast enough, and it bursts, with a splash as big as
 * the shaking made it; a shaken one bursts at a gentler speed than a fresh one.
 * Slower than that and it only lands, to be picked up again.
 */

export interface VesselSpec {
  readonly item: ItemType;
  /** Throw speeds at the lightest and the fullest charge, m/s. */
  readonly putMin: number;
  readonly putMax: number;
  /** Speed into a surface, m/s, at which a fresh one bursts, and a fully shaken one. */
  readonly burstSpeed: number;
  readonly shakenBurstSpeed: number;
  /** How big the spray is, as a multiple of the standard burst: a fresh one, a fully shaken one. */
  readonly splash: number;
  readonly shakenSplash: number;
  /** Radius of the stain it leaves, metres: a fresh one, a fully shaken one. Zero: none. */
  readonly stain: number;
  readonly shakenStain: number;
  /** Radius of the body in flight, metres. */
  readonly radius: number;
}

export const VESSELS: readonly VesselSpec[] = [
  {
    item: ItemType.MountainLightning,
    putMin: 9,
    putMax: 26,
    burstSpeed: 15,
    shakenBurstSpeed: 5,
    splash: 1,
    shakenSplash: 2.4,
    stain: 0,
    shakenStain: 0,
    radius: 0.07,
  },
  {
    item: ItemType.Goo,
    // It is slime: it does not go far, and it does not need much of a knock to splat.
    putMin: 4,
    putMax: 11,
    burstSpeed: 2.5,
    shakenBurstSpeed: 1.5,
    splash: 0.8,
    shakenSplash: 1.6,
    stain: 1.1,
    shakenStain: 1.8,
    radius: 0.09,
  },
];

export function vesselOf(item: ItemType | undefined): VesselSpec | undefined {
  return VESSELS.find((spec) => spec.item === item);
}

/** Seconds of holding left mouse that shake a vessel to the full, and how fast a shaken one settles, per second. */
export const SHAKE_FILL_SECONDS = 1.4;
export const SHAKE_SETTLE_PER_SECOND = 0.08;

/** How shaken up the vessel in the hand is, 0 (fresh) to 1 (as shaken as it gets). */
export class Shake {
  level = 0;

  update(dt: number, shaking: boolean): void {
    if (shaking) this.level = Math.min(1, this.level + dt / SHAKE_FILL_SECONDS);
    else this.level = Math.max(0, this.level - dt * SHAKE_SETTLE_PER_SECOND);
  }

  reset(): void {
    this.level = 0;
  }
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Speed into a surface at which a vessel with this much shaking bursts. */
export function burstSpeedAt(spec: VesselSpec, shake: number): number {
  return lerp(spec.burstSpeed, spec.shakenBurstSpeed, shake);
}

export function splashAt(spec: VesselSpec, shake: number): number {
  return lerp(spec.splash, spec.shakenSplash, shake);
}

export function stainAt(spec: VesselSpec, shake: number): number {
  return lerp(spec.stain, spec.shakenStain, shake);
}

/** Throw speed at a charge from 0 to 1. */
export function putSpeedAt(spec: VesselSpec, charge: number): number {
  return lerp(spec.putMin, spec.putMax, Math.min(1, Math.max(0, charge)));
}

// --- in flight -----------------------------------------------------------

const GRAVITY = 12;
const MAX_SECONDS = 8;
const FALL_LIMIT_Y = -5;
/** The part of the speed into a surface a vessel that does not burst bounces back with. */
const BOUNCE = 0.25;

export interface FlyingVessel {
  readonly spec: VesselSpec;
  /** How shaken it was when it left the hand. */
  readonly shake: number;
  x: number;
  y: number;
  z: number;
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
}

/** A vessel that burst: where, which way the surface faces, and how hard it met it. */
export interface Splat {
  readonly spec: VesselSpec;
  readonly shake: number;
  x: number;
  y: number;
  z: number;
  /** Unit normal of the surface it met. */
  nx: number;
  ny: number;
  nz: number;
  /** Speed into the surface, m/s. */
  speed: number;
}

/** A vessel that met something too gently to burst: it is an item again, moving as given. */
export interface Landing {
  readonly item: ItemType;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export class ThrownVessels {
  readonly flying: FlyingVessel[] = [];
  /** Since the caller last emptied them; theirs to clear. */
  readonly splats: Splat[] = [];
  readonly landings: Landing[] = [];
  private readonly hit = createSphereCollision();

  throw(
    spec: VesselSpec,
    shake: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
  ): void {
    this.flying.push({ spec, shake, x, y, z, prevX: x, prevY: y, prevZ: z, vx, vy, vz, age: 0 });
  }

  step(dt: number, query: SolidQuery): void {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const body = this.flying[i];
      if (body === undefined) continue;
      body.prevX = body.x;
      body.prevY = body.y;
      body.prevZ = body.z;
      body.age += dt;
      // A fast throw is swept in pieces no longer than the body is wide, or it
      // would end a step well inside the floor and burst from there.
      const reach = Math.hypot(body.vx, body.vy, body.vz) * dt;
      const pieces = Math.max(1, Math.ceil(reach / (body.spec.radius * 0.8)));
      const piece = dt / pieces;
      let hit = false;
      for (let p = 0; p < pieces && !hit; p++) {
        body.vy -= GRAVITY * piece;
        const r = sweepSphere(query, body.x, body.y, body.z, body.spec.radius, body.vx, body.vy, body.vz, piece, this.hit);
        // The velocity the contact took away points along the surface normal.
        const lostX = r.vx - body.vx;
        const lostY = r.vy - body.vy;
        const lostZ = r.vz - body.vz;
        const lost = Math.hypot(lostX, lostY, lostZ);
        if (lost > 1e-4) {
          const nx = lostX / lost;
          const ny = lostY / lost;
          const nz = lostZ / lost;
          if (lost >= burstSpeedAt(body.spec, body.shake)) {
            this.splats.push({ spec: body.spec, shake: body.shake, x: r.x, y: r.y, z: r.z, nx, ny, nz, speed: lost });
          } else {
            this.landings.push({
              item: body.spec.item,
              x: r.x,
              y: r.y,
              z: r.z,
              vx: r.vx + nx * lost * BOUNCE,
              vy: r.vy + ny * lost * BOUNCE,
              vz: r.vz + nz * lost * BOUNCE,
            });
          }
          hit = true;
          break;
        }
        body.x = r.x;
        body.y = r.y;
        body.z = r.z;
      }
      if (hit || body.age > MAX_SECONDS || body.y < FALL_LIMIT_Y) this.removeAt(i);
    }
  }

  clear(): void {
    this.flying.length = 0;
    this.splats.length = 0;
    this.landings.length = 0;
  }

  private removeAt(index: number): void {
    const last = this.flying.pop();
    if (last !== undefined && index < this.flying.length) this.flying[index] = last;
  }
}
