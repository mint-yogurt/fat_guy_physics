import type { Inventory, ItemType } from "./inventory.ts";

/**
 * Dropped items: they fall from wherever they were knocked loose, land on
 * the terrain below, hover-bob, and are collected by walking near them.
 * Ports src/ItemPickup.{hpp,cpp}.
 *
 * Pickups fall on a scalar gravity rather than as rigid bodies. They are
 * decorative until touched, there can be dozens at once, and a leaf that
 * tumbles realistically is not worth a Jolt body each.
 */

const FALL_GRAVITY = -9;
const PICKUP_RADIUS = 0.7;
const BOB_SPEED = 2.5;
const BOB_AMPLITUDE = 0.04;
const HOVER_HEIGHT = 0.08;

/** Given up on after this long, so a drop into a hole is not forever. */
const MAX_LIFETIME_SECONDS = 180;

export interface Pickup {
  readonly id: number;
  readonly type: ItemType;
  x: number;
  y: number;
  z: number;
  /** Terrain surface directly below the spawn, sampled once. */
  readonly groundY: number;
  velocityY: number;
  landed: boolean;
  readonly spawnTime: number;
}

export class PickupField {
  readonly items: Pickup[] = [];
  private nextId = 1;

  /** Ids removed since the last call, for the renderer to drop meshes. */
  readonly removed: number[] = [];

  spawn(type: ItemType, x: number, y: number, z: number, groundY: number, now: number): void {
    this.items.push({
      id: this.nextId++,
      type,
      x,
      y,
      z,
      groundY,
      velocityY: 0,
      landed: false,
      spawnTime: now,
    });
  }

  /** Falls, bobs, and collects. Call once per frame, not per substep. */
  update(
    dt: number,
    now: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    inventory: Inventory,
  ): void {
    this.removed.length = 0;
    const radiusSq = PICKUP_RADIUS * PICKUP_RADIUS;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      if (item === undefined) continue;

      if (!item.landed) {
        item.velocityY += FALL_GRAVITY * dt;
        item.y += item.velocityY * dt;
        if (item.y <= item.groundY + HOVER_HEIGHT) {
          item.y = item.groundY + HOVER_HEIGHT;
          item.landed = true;
        }
      } else {
        item.y =
          item.groundY +
          HOVER_HEIGHT +
          Math.sin((now - item.spawnTime) * BOB_SPEED) * BOB_AMPLITUDE;
      }

      const dx = item.x - playerX;
      // Against the player's middle rather than their feet, so a pickup is
      // not collected from a storey below.
      const dy = item.y - (playerY + 0.9);
      const dz = item.z - playerZ;
      const collected = dx * dx + dy * dy + dz * dz <= radiusSq && inventory.tryAdd(item.type);

      if (collected || now - item.spawnTime > MAX_LIFETIME_SECONDS) {
        this.removed.push(item.id);
        this.items.splice(i, 1);
      }
    }
  }

  clear(): void {
    this.removed.length = 0;
    for (const item of this.items) this.removed.push(item.id);
    this.items.length = 0;
  }
}
