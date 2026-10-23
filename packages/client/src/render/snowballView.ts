import { Group, Quaternion, Sprite, SpriteMaterial, Vector3, type Object3D, type Scene } from "three/webgpu";

import { ItemType } from "@fgp/shared/items/inventory";
import { CARTON_RADIUS, TOILET_PAPER_RADIUS, itemOfBall } from "@fgp/shared/items/rolledItems";
import { ROCK_RADIUS } from "@fgp/shared/items/rock";
import {
  SNOW_UNIT_RADIUS,
  type Flying,
  type Snowball,
  type SnowballField,
} from "@fgp/shared/items/snowball";

import type { ItemAssets } from "./itemAssets.ts";

/**
 * Snow that is out in the world rather than in a hand: snowballs rolling or
 * lying about, snowballs in flight, and the puffs they burst into.
 *
 * A rolled snowball is the item's mesh scaled up to its radius and turned as
 * it travels, so it reads as rolling; the sim only knows where it is. Drawn
 * between substeps like the player is.
 *
 * A roll of toilet paper rolls like a wheel instead (its axis across the way it goes, spun by the
 * distance covered) and stands on end when it stops. The paper it leaves behind is paperTrail.ts.
 */

interface RolledView {
  root: Group;
  spin: Group;
  lastX: number;
  lastZ: number;
  /** A rock or a carton: drawn from its own mesh, and laid down when it stops. Snow: undefined. */
  item: ItemType | undefined;
  /** Radius of a standard one of its kind, metres; the mesh is drawn at this size when the ball is. */
  standard: number;
  /** Half its thickness as drawn at the standard size, metres, when it lies down. */
  restHalf: number;
  /** 0 while rolling, easing to 1 as it settles into its lying pose. */
  lying: number;
  /** Toilet paper only: the way it last travelled (a yaw), and how far it has turned about its axis. */
  heading: number;
  turned: number;
}

/** How fast a rock that has stopped eases into lying on its flat side, per frame. */
const LIE_DOWN_RATE = 0.2;

const axis = new Vector3();
const turn = new Quaternion();
const lyingPose = new Quaternion();
const quarter = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
const yawAxis = new Vector3(0, 1, 0);
const zAxis = new Vector3(0, 0, 1);
/** Lays a standing roll's axis (Y) along the sideways direction (X) of the way it is heading. */
const onItsSide = new Quaternion().setFromAxisAngle(zAxis, -Math.PI / 2);
const headingTurn = new Quaternion();
const spinTurn = new Quaternion();
const standingTurn = new Quaternion();

function standardRadius(item: ItemType | undefined): number {
  if (item === ItemType.Rock) return ROCK_RADIUS;
  if (item === ItemType.Eggnog) return CARTON_RADIUS;
  if (item === ItemType.ToiletPaper) return TOILET_PAPER_RADIUS;
  return SNOW_UNIT_RADIUS;
}

export class SnowballsView {
  private readonly rolled = new Map<number, RolledView>();
  private readonly flying: Object3D[] = [];
  private readonly seen = new Set<number>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
  ) {}

  private meshOf(item: ItemType | undefined): Object3D {
    if (item === ItemType.Rock) return this.assets.rock;
    if (item === ItemType.Eggnog) return this.assets.eggnog;
    if (item === ItemType.ToiletPaper) return this.assets.toiletPaperRoll;
    return this.assets.snowball;
  }

  private makeBall(item?: ItemType): Group {
    const root = new Group();
    const spin = new Group();
    const mesh = this.meshOf(item).clone();
    mesh.traverse((child) => {
      child.frustumCulled = false;
    });
    spin.add(mesh);
    root.add(spin);
    this.scene.add(root);
    return root;
  }

  sync(field: SnowballField, flying: readonly Flying[], alpha: number): void {
    this.seen.clear();
    for (const ball of field.balls) {
      if (ball.spent) continue;
      this.seen.add(ball.id);
      let view = this.rolled.get(ball.id);
      if (view === undefined) {
        const item = itemOfBall(ball);
        const root = this.makeBall(item);
        view = {
          root,
          spin: root.children[0] as Group,
          lastX: ball.x,
          lastZ: ball.z,
          item,
          standard: standardRadius(item),
          restHalf:
            item === ItemType.Eggnog
              ? this.assets.eggnogRestHalfHeight
              : item === ItemType.ToiletPaper
                ? this.assets.toiletPaperRestHalfHeight
                : this.assets.rockRestHalfHeight,
          lying: 0,
          heading: ball.id * 2.1,
          turned: 0,
        };
        // Each one starts turned differently, so a field of them is not a row of twins.
        view.spin.rotation.set(ball.id * 1.7, ball.id * 2.9, ball.id * 0.6);
        // A rock the world placed starts already lying down.
        if (item !== undefined && !ball.rolling) {
          this.lieDown(view, ball, 1);
        }
        this.rolled.set(ball.id, view);
      }
      this.place(view, ball, alpha);
    }
    for (const [id, view] of this.rolled) {
      if (this.seen.has(id)) continue;
      this.scene.remove(view.root);
      this.rolled.delete(id);
    }

    while (this.flying.length < flying.length) this.flying.push(this.makeFlying());
    for (let i = 0; i < this.flying.length; i++) {
      const object = this.flying[i];
      const ball = flying[i];
      if (object === undefined) continue;
      object.visible = ball !== undefined;
      if (ball === undefined) continue;
      object.position.set(
        ball.prevX + (ball.x - ball.prevX) * alpha,
        ball.prevY + (ball.y - ball.prevY) * alpha,
        ball.prevZ + (ball.z - ball.prevZ) * alpha,
      );
      object.rotation.set(ball.age * 9, ball.age * 5, 0);
    }
  }

  private place(view: RolledView, ball: Snowball, alpha: number): void {
    const x = ball.prevX + (ball.x - ball.prevX) * alpha;
    const y = ball.prevY + (ball.y - ball.prevY) * alpha;
    const z = ball.prevZ + (ball.z - ball.prevZ) * alpha;
    view.root.position.set(x, y, z);
    view.spin.scale.setScalar(ball.radius / view.standard);
    if (view.item === ItemType.ToiletPaper) {
      this.placeRoll(view, ball, x, z);
      view.lastX = x;
      view.lastZ = z;
      return;
    }
    if (view.item !== undefined) {
      // Rolling it is a ball; once it stops it settles onto its flat side and sinks into the
      // ground a touch, as a rock does, instead of balancing on a corner or floating.
      if (ball.rolling) {
        view.lying = 0;
        view.spin.position.y = 0;
      } else if (view.lying < 1) {
        const next = view.lying + (1 - view.lying) * LIE_DOWN_RATE;
        this.lieDown(view, ball, 1 - next < 0.01 ? 1 : next);
      }
    }
    if (ball.rolling) {
      // Rolling without slipping: about the horizontal axis at right angles to
      // the way it moved, by distance over radius.
      const dx = x - view.lastX;
      const dz = z - view.lastZ;
      const distance = Math.hypot(dx, dz);
      if (distance > 1e-5) {
        axis.set(dz, 0, -dx).divideScalar(distance);
        view.spin.quaternion.premultiply(turn.setFromAxisAngle(axis, distance / ball.radius));
      }
    }
    view.lastX = x;
    view.lastZ = z;
  }

  /** A roll of toilet paper: a wheel while it goes, stood on its end once it stops. */
  private placeRoll(view: RolledView, ball: Snowball, x: number, z: number): void {
    const dx = x - view.lastX;
    const dz = z - view.lastZ;
    const distance = Math.hypot(dx, dz);
    if (distance > 1e-4) {
      view.heading = Math.atan2(dx, dz);
      view.turned += distance / ball.radius;
    }
    headingTurn.setFromAxisAngle(yawAxis, view.heading);
    spinTurn.setFromAxisAngle(yawAxis, view.turned);
    view.spin.quaternion.copy(headingTurn).multiply(onItsSide).multiply(spinTurn);
    if (ball.rolling) {
      view.lying = 0;
      view.spin.position.y = 0;
      return;
    }
    // Stopped: it settles on its end and sinks to the ground, a roll being flatter than the ball round it.
    view.lying += (1 - view.lying) * LIE_DOWN_RATE;
    if (1 - view.lying < 0.01) view.lying = 1;
    standingTurn.setFromAxisAngle(yawAxis, view.heading);
    view.spin.quaternion.slerp(standingTurn, view.lying);
    view.spin.position.y = view.lying * (view.restHalf * (ball.radius / view.standard) - ball.radius);
  }

  /** Eases a rock (or a carton on its side) toward lying down, `amount` of the way there (1: all the way). */
  private lieDown(view: RolledView, ball: Snowball, amount: number): void {
    view.lying = amount;
    // Facing a different way per rock, so a scatter of them is not a row of twins.
    lyingPose.setFromAxisAngle(yawAxis, ball.id * 2.4).multiply(quarter);
    if (amount >= 1) view.spin.quaternion.copy(lyingPose);
    else view.spin.quaternion.slerp(lyingPose, LIE_DOWN_RATE);
    const scale = ball.radius / view.standard;
    view.spin.position.y = amount * (view.restHalf * scale - ball.radius);
  }

  private makeFlying(): Object3D {
    const root = this.makeBall();
    // A put snowball is a little ball, a touch smaller than the item at rest.
    root.scale.setScalar(0.9);
    return root;
  }

  dispose(): void {
    for (const view of this.rolled.values()) this.scene.remove(view.root);
    this.rolled.clear();
    for (const object of this.flying) this.scene.remove(object);
    this.flying.length = 0;
  }
}

// --- puffs -----------------------------------------------------------------

const MAX_PUFFS = 120;
const PUFF_LIFE = 0.55;
const PUFF_SIZE = 0.1;
const PUFF_GRAVITY = 7;

interface Puff {
  sprite: Sprite;
  vx: number;
  vy: number;
  vz: number;
  life: number;
}

/** A burst of snow: a handful of white specks flung out, falling and shrinking. */
export class SnowPuffs {
  private readonly puffs: Puff[] = [];
  private readonly material = new SpriteMaterial({ color: 0xffffff });
  private next = 0;

  constructor(private readonly scene: Scene) {
    for (let i = 0; i < MAX_PUFFS; i++) {
      const sprite = new Sprite(this.material);
      sprite.visible = false;
      scene.add(sprite);
      this.puffs.push({ sprite, vx: 0, vy: 0, vz: 0, life: 0 });
    }
  }

  /**
   * `count` specks from a point, thrown out around (nx, ny, nz): the surface
   * normal, or whichever way the puff should lean.
   */
  burst(x: number, y: number, z: number, nx: number, ny: number, nz: number, count = 12, speed = 3): void {
    for (let i = 0; i < count; i++) {
      const puff = this.puffs[this.next];
      this.next = (this.next + 1) % MAX_PUFFS;
      if (puff === undefined) continue;
      const spread = 0.8;
      puff.vx = (nx + (Math.random() - 0.5) * 2 * spread) * speed * (0.4 + Math.random() * 0.8);
      puff.vy = (ny + (Math.random() - 0.3) * 1.4 * spread) * speed * (0.4 + Math.random() * 0.8);
      puff.vz = (nz + (Math.random() - 0.5) * 2 * spread) * speed * (0.4 + Math.random() * 0.8);
      puff.life = PUFF_LIFE * (0.6 + Math.random() * 0.6);
      puff.sprite.position.set(x, y, z);
      puff.sprite.scale.setScalar(PUFF_SIZE);
      puff.sprite.visible = true;
    }
  }

  update(dt: number): void {
    for (const puff of this.puffs) {
      if (puff.life <= 0) continue;
      puff.life -= dt;
      if (puff.life <= 0) {
        puff.sprite.visible = false;
        continue;
      }
      puff.vy -= PUFF_GRAVITY * dt;
      puff.sprite.position.x += puff.vx * dt;
      puff.sprite.position.y += puff.vy * dt;
      puff.sprite.position.z += puff.vz * dt;
      puff.sprite.scale.setScalar(PUFF_SIZE * Math.min(1, (puff.life / PUFF_LIFE) * 2.2));
    }
  }

  dispose(): void {
    for (const puff of this.puffs) this.scene.remove(puff.sprite);
    this.material.dispose();
  }
}
