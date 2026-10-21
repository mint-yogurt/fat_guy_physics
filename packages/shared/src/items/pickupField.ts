import type { Inventory, ItemType } from "./inventory.ts";

/**
 * Dropped items: they are thrown out of wherever they were knocked loose,
 * land on the terrain, and hover there -- bobbing and slowly spinning, so
 * they are easy to spot -- until the player picks them up with E. Ports
 * src/ItemPickup.{hpp,cpp}, minus its walk-over auto-collect.
 *
 * Pickups fly on a scalar gravity rather than as rigid bodies. They are
 * decorative until picked up, there can be dozens at once, and a leaf that
 * tumbles realistically is not worth a Jolt body each.
 *
 * A thrown stick that embeds in something is a pickup too, just a *stuck*
 * one: it stays exactly where it went in, at the angle it went in, and
 * neither falls, bobs nor spins.
 */

const FALL_GRAVITY = -9;
const BOB_SPEED = 2.5;
const BOB_AMPLITUDE = 0.05;
/** High enough that a log does not sink into the ground at the bottom of its bob. */
const HOVER_HEIGHT = 0.28;
/** Horizontal speed lost per second once an item is flying; a little air drag. */
const AIR_DRAG = 0.6;

/** How far E reaches, and how far off the crosshair an item may be and still be the target. */
export const PICKUP_REACH = 2.6;
const AIM_SLACK = 0.45;
/** Anything this close to the player's middle is pickable without aiming at it. */
const NEAR_RADIUS = 1.1;

/** Landing slower than this (m/s) settles instead of bouncing, even on a springy surface. */
const MIN_BOUNCE_SPEED = 1;

/** Given up on after this long, so a drop into a hole is not forever. */
const MAX_LIFETIME_SECONDS = 600;

/** Terrain height under a point, metres. */
export type GroundSampler = (x: number, z: number) => number;

/** How much of its landing speed the surface under a point gives back; 0 for dead ground. */
export type RestitutionSampler = (x: number, z: number) => number;

export interface Pickup {
  readonly id: number;
  readonly type: ItemType;
  x: number;
  y: number;
  z: number;
  /** Terrain under the item, re-sampled while it moves sideways. */
  groundY: number;
  vx: number;
  vy: number;
  vz: number;
  landed: boolean;
  readonly spawnTime: number;
  /**
   * Set for an embedded stick: the direction it was flying when it went in,
   * business end first. Position is then the butt.
   */
  readonly stuck: { readonly x: number; readonly y: number; readonly z: number } | undefined;
}

export class PickupField {
  readonly items: Pickup[] = [];
  private nextId = 1;

  /** Ids removed since the last call, for the renderer to drop meshes. */
  readonly removed: number[] = [];

  /** Spawns an item at a point, optionally thrown out at a velocity. */
  spawn(
    type: ItemType,
    x: number,
    y: number,
    z: number,
    groundY: number,
    now: number,
    vx = 0,
    vy = 0,
    vz = 0,
  ): void {
    this.items.push({
      id: this.nextId++,
      type,
      x,
      y,
      z,
      groundY,
      vx,
      vy,
      vz,
      landed: false,
      spawnTime: now,
      stuck: undefined,
    });
  }

  /** A stick embedded where it landed: `dir` is its flight direction, unit length. */
  spawnStuck(
    type: ItemType,
    buttX: number,
    buttY: number,
    buttZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    now: number,
  ): void {
    this.items.push({
      id: this.nextId++,
      type,
      x: buttX,
      y: buttY,
      z: buttZ,
      groundY: buttY,
      vx: 0,
      vy: 0,
      vz: 0,
      landed: true,
      spawnTime: now,
      stuck: { x: dirX, y: dirY, z: dirZ },
    });
  }

  /** Flies, lands, bobs and expires. Call once per frame, not per substep. */
  update(dt: number, now: number, ground: GroundSampler, restitution?: RestitutionSampler): void {
    this.removed.length = 0;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item === undefined) continue;

      if (item.stuck !== undefined) {
        // Nothing to do but wait to be picked up.
      } else if (!item.landed) {
        item.vy += FALL_GRAVITY * dt;
        const drag = Math.max(0, 1 - AIR_DRAG * dt);
        item.vx *= drag;
        item.vz *= drag;
        item.x += item.vx * dt;
        item.y += item.vy * dt;
        item.z += item.vz * dt;
        if (item.vx !== 0 || item.vz !== 0) item.groundY = ground(item.x, item.z);
        if (item.y <= item.groundY + HOVER_HEIGHT && item.vy <= 0) {
          item.y = item.groundY + HOVER_HEIGHT;
          const bounce = restitution?.(item.x, item.z) ?? 0;
          if (bounce > 0 && -item.vy > MIN_BOUNCE_SPEED) {
            // A springy surface: back up with what it was given, sideways
            // motion untouched.
            item.vy = -item.vy * bounce;
          } else {
            item.vx = 0;
            item.vy = 0;
            item.vz = 0;
            item.landed = true;
          }
        }
      } else {
        item.y =
          item.groundY +
          HOVER_HEIGHT +
          Math.sin((now - item.spawnTime) * BOB_SPEED) * BOB_AMPLITUDE;
      }

      if (item.stuck === undefined && now - item.spawnTime > MAX_LIFETIME_SECONDS) {
        this.removed.push(item.id);
        this.items.splice(i, 1);
      }
    }
  }

  /**
   * The item E would pick up: the one nearest the crosshair ray within
   * reach, else anything right at the player's feet. `dir` is unit length.
   */
  target(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    playerX: number,
    playerY: number,
    playerZ: number,
  ): Pickup | undefined {
    let best: Pickup | undefined;
    let bestScore = Infinity;
    for (const item of this.items) {
      const dx = item.x - eyeX;
      const dy = item.y - eyeY;
      const dz = item.z - eyeZ;
      const along = dx * dirX + dy * dirY + dz * dirZ;
      if (along > 0 && along <= PICKUP_REACH) {
        const offSq = dx * dx + dy * dy + dz * dz - along * along;
        if (offSq <= AIM_SLACK * AIM_SLACK && offSq < bestScore) {
          best = item;
          bestScore = offSq;
        }
      }
    }
    if (best !== undefined) return best;

    let nearestSq = NEAR_RADIUS * NEAR_RADIUS;
    for (const item of this.items) {
      const dx = item.x - playerX;
      // Against the player's middle rather than their feet, so a pickup is
      // not collected from a storey below.
      const dy = item.y - (playerY + 0.6);
      const dz = item.z - playerZ;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq <= nearestSq) {
        best = item;
        nearestSq = dSq;
      }
    }
    return best;
  }

  /** Moves an item into the inventory. False, and it stays put, if the inventory is full. */
  collect(item: Pickup, inventory: Inventory): boolean {
    const index = this.items.indexOf(item);
    if (index < 0 || !inventory.tryAdd(item.type)) return false;
    this.items.splice(index, 1);
    this.removed.push(item.id);
    return true;
  }

  /** Lets landed items near a point fall again, for when whatever they rested on has gone. */
  dropNear(x: number, z: number, radius: number): void {
    for (const item of this.items) {
      if (item.stuck === undefined && item.landed && Math.hypot(item.x - x, item.z - z) <= radius) {
        item.landed = false;
      }
    }
  }

  clear(): void {
    this.removed.length = 0;
    for (const item of this.items) this.removed.push(item.id);
    this.items.length = 0;
  }
}
