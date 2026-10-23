import {
  BufferAttribute,
  DynamicDrawUsage,
  BufferGeometry,
  Mesh,
  type Scene,
} from "three/webgpu";

import { ItemType } from "@fgp/shared/items/inventory";
import { itemOfBall } from "@fgp/shared/items/rolledItems";
import type { Snowball, SnowballField } from "@fgp/shared/items/snowball";

import type { PaperParts } from "./paperFlap.ts";

/**
 * The paper a roll of toilet paper leaves behind it. The flap, copied: a ribbon the flap's width, made of
 * flap-length cells with the flap's own texture, laid down as the roll goes.
 *
 *  - Rolled along the ground, each cell is put straight down where the roll has been, conforming to the
 *    ground (and to whatever is on it) under each of its corners.
 *  - Thrown, cells are left in the air along the way. They fall slowly, as paper does, and settle onto
 *    whatever is under them when they get there: the ground, a log, a snowbank, a roof.
 *
 * It is not a cloth simulation. A cell is four corners; falling ones are each a floating particle, settled
 * ones are fixed until they fade. Trails fade away some time after the roll has left them.
 */

/** Longest a ribbon mesh is, in cells. A long unrolling carries on in a fresh mesh. */
const CELLS_PER_TRAIL = 120;
/** Ribbon meshes kept at once; past this the oldest is recycled. */
const MAX_TRAILS = 40;
/** Seconds a trail lies after the roll has left it, and then takes to shrink away. */
const TRAIL_LIFE_SECONDS = 90;
const TRAIL_FADE_SECONDS = 4;
/** A cell's drop and drift: paper falls at about GRAVITY/DRAG metres per second and loses its sideways push fast. */
const FALL_GRAVITY = 5;
const FALL_DRAG = 2.2;
/** Share of the roll's speed a cell leaves it with, and a random drift on top, m/s. */
const LEAVE_SHARE = 0.18;
const LEAVE_DRIFT = 0.35;
/** Paper lies this far over the ground, metres. */
const LIE_HEIGHT = 0.02;
/** A roll this close to what is under it is on it; further and it is in the air. */
const ON_SURFACE = 0.07;
/** Cells put down in one frame at most (a teleport leaves a gap rather than a stampede). */
const MAX_PER_FRAME = 80;
/** The corners of a settling cell may be this far from its middle in height, metres. */
const MAX_CORNER_OFFSET = 0.15;

/** The height of what is under (x, z) at or below about y: ground, or something stood on it. */
export type SupportQuery = (x: number, y: number, z: number) => number;

class Trail {
  readonly geometry = new BufferGeometry();
  readonly mesh: Mesh;
  private readonly position: Float32Array;
  private readonly uv: Float32Array;
  /** Samples: the cell i runs from sample i to sample i + 1. Middle, lateral direction, speed, state. */
  private readonly x = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly y = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly z = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly lx = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly lz = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly vx = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly vy = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly vz = new Float32Array(CELLS_PER_TRAIL + 1);
  /** How far each corner sits above the middle, once settled. */
  private readonly offsetLeft = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly offsetRight = new Float32Array(CELLS_PER_TRAIL + 1);
  private readonly settled = new Uint8Array(CELLS_PER_TRAIL + 1);
  count = 0;
  /** Seconds since a sample was last put in; the roll is still adding to it while this is small. */
  idle = 0;
  /** 1 while it lies there, falling to 0 as it fades. */
  thickness = 1;
  /** Set when something moved, so the vertices are rewritten. */
  private dirty = false;
  private falling = 0;
  /** When it was started, to recycle the oldest. */
  serial = 0;

  constructor(
    private readonly parts: PaperParts,
    scene: Scene,
  ) {
    const cells = CELLS_PER_TRAIL;
    this.position = new Float32Array(cells * 4 * 3);
    this.uv = new Float32Array(cells * 4 * 2);
    const normal = new Float32Array(cells * 4 * 3);
    for (let i = 0; i < cells * 4; i++) normal[i * 3 + 1] = 1;
    const index = new Uint16Array(cells * 6);
    for (let c = 0; c < cells; c++) {
      const v = c * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], c * 6);
    }
    this.geometry.setAttribute("position", new BufferAttribute(this.position, 3).setUsage(DynamicDrawUsage));
    this.geometry.setAttribute("normal", new BufferAttribute(normal, 3));
    this.geometry.setAttribute("uv", new BufferAttribute(this.uv, 2));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    this.mesh = new Mesh(this.geometry, parts.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get full(): boolean {
    return this.count >= CELLS_PER_TRAIL + 1;
  }

  start(serial: number): void {
    this.count = 0;
    this.idle = 0;
    this.thickness = 1;
    this.falling = 0;
    this.dirty = false;
    this.serial = serial;
    this.geometry.setDrawRange(0, 0);
    this.mesh.visible = true;
  }

  stop(): void {
    this.count = 0;
    this.mesh.visible = false;
  }

  /** Adds a sample, the next one along: laid on what is under it if `support` is given, else left in the air to fall. */
  add(
    x: number,
    y: number,
    z: number,
    lx: number,
    lz: number,
    vx: number,
    vy: number,
    vz: number,
    support: SupportQuery | undefined,
  ): void {
    const i = this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = z;
    this.lx[i] = lx;
    this.lz[i] = lz;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.offsetLeft[i] = 0;
    this.offsetRight[i] = 0;
    this.settled[i] = 0;
    this.falling++;
    if (support !== undefined) this.settle(i, support);
    this.idle = 0;
    this.thickness = 1;
    this.dirty = true;
    if (i > 0) this.writeCellUv(i - 1);
    this.geometry.setDrawRange(0, Math.max(0, i) * 6);
  }

  /** Puts sample `i` on whatever is under it, its corners following the surface under each. */
  private settle(i: number, support: SupportQuery): void {
    const half = (this.parts.shape?.width ?? 0.07) / 2;
    const x = this.x[i] ?? 0;
    const z = this.z[i] ?? 0;
    const lx = this.lx[i] ?? 0;
    const lz = this.lz[i] ?? 0;
    const top = (this.y[i] ?? 0) + MAX_CORNER_OFFSET;
    const middle = support(x, top, z) + LIE_HEIGHT;
    this.y[i] = middle;
    const clamp = (value: number): number => Math.max(-MAX_CORNER_OFFSET, Math.min(MAX_CORNER_OFFSET, value));
    this.offsetLeft[i] = clamp(support(x + lx * half, middle + MAX_CORNER_OFFSET, z + lz * half) + LIE_HEIGHT - middle);
    this.offsetRight[i] = clamp(support(x - lx * half, middle + MAX_CORNER_OFFSET, z - lz * half) + LIE_HEIGHT - middle);
    this.vx[i] = 0;
    this.vy[i] = 0;
    this.vz[i] = 0;
    if (this.settled[i] === 0) this.falling--;
    this.settled[i] = 1;
    this.dirty = true;
  }

  /** Cell `c` (from sample c to c + 1) takes the flap's whole texture rectangle. */
  private writeCellUv(c: number): void {
    const uv = this.parts.shape?.uv;
    if (uv === undefined) return;
    const base = c * 4 * 2;
    // Corner order: left start, right start, left end, right end; left is the flap's "other side" corner.
    const put = (slot: number, along: number, left: number): void => {
      this.uv[base + slot * 2] = uv.a[0] + (uv.b[0] - uv.a[0]) * along + (uv.c[0] - uv.a[0]) * left;
      this.uv[base + slot * 2 + 1] = uv.a[1] + (uv.b[1] - uv.a[1]) * along + (uv.c[1] - uv.a[1]) * left;
    };
    put(0, 0, 1);
    put(1, 0, 0);
    put(2, 1, 1);
    put(3, 1, 0);
    (this.geometry.getAttribute("uv") as BufferAttribute).needsUpdate = true;
  }

  /** Falls what has not landed yet, ages the trail, and rewrites the vertices if anything moved. */
  update(dt: number, support: SupportQuery): void {
    if (this.count === 0) return;
    this.idle += dt;
    const fading = this.idle > TRAIL_LIFE_SECONDS;
    if (fading) {
      this.thickness = Math.max(0, 1 - (this.idle - TRAIL_LIFE_SECONDS) / TRAIL_FADE_SECONDS);
      this.dirty = true;
    }
    if (this.falling > 0) {
      const drag = Math.exp(-FALL_DRAG * dt);
      for (let i = 0; i < this.count; i++) {
        if (this.settled[i] === 1) continue;
        this.vy[i] = ((this.vy[i] ?? 0) - FALL_GRAVITY * dt) * drag;
        this.vx[i] = (this.vx[i] ?? 0) * drag;
        this.vz[i] = (this.vz[i] ?? 0) * drag;
        this.x[i] = (this.x[i] ?? 0) + (this.vx[i] ?? 0) * dt;
        this.y[i] = (this.y[i] ?? 0) + (this.vy[i] ?? 0) * dt;
        this.z[i] = (this.z[i] ?? 0) + (this.vz[i] ?? 0) * dt;
        const ground = support(this.x[i] ?? 0, this.y[i] ?? 0, this.z[i] ?? 0);
        if ((this.y[i] ?? 0) <= ground + LIE_HEIGHT) this.settle(i, support);
        this.dirty = true;
      }
    }
    if (this.dirty) this.rewrite();
  }

  /** True once it has faded away. */
  get gone(): boolean {
    return this.thickness <= 0;
  }

  private rewrite(): void {
    this.dirty = false;
    const half = ((this.parts.shape?.width ?? 0.07) / 2) * this.thickness;
    const cells = this.count - 1;
    const out = this.position;
    for (let c = 0; c < cells; c++) {
      for (let end = 0; end < 2; end++) {
        const i = c + end;
        const x = this.x[i] ?? 0;
        const y = this.y[i] ?? 0;
        const z = this.z[i] ?? 0;
        const lx = (this.lx[i] ?? 0) * half;
        const lz = (this.lz[i] ?? 0) * half;
        const slot = c * 4 + end * 2;
        out[slot * 3] = x + lx;
        out[slot * 3 + 1] = y + (this.offsetLeft[i] ?? 0);
        out[slot * 3 + 2] = z + lz;
        out[slot * 3 + 3] = x - lx;
        out[slot * 3 + 4] = y + (this.offsetRight[i] ?? 0);
        out[slot * 3 + 5] = z - lz;
      }
    }
    (this.geometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
  }

  /** The last sample put in, for a trail that carries on in a fresh mesh. */
  lastSample(out: { x: number; y: number; z: number; lx: number; lz: number }): void {
    const i = this.count - 1;
    out.x = this.x[i] ?? 0;
    out.y = this.y[i] ?? 0;
    out.z = this.z[i] ?? 0;
    out.lx = this.lx[i] ?? 0;
    out.lz = this.lz[i] ?? 0;
  }

  dispose(scene: Scene): void {
    scene.remove(this.mesh);
    this.geometry.dispose();
  }
}

/** What follows one roll about. */
interface Follow {
  trail: Trail | undefined;
  lastX: number;
  lastY: number;
  lastZ: number;
  /** Distance travelled since the last cell was put down. */
  carry: number;
  lx: number;
  lz: number;
}

const carried = { x: 0, y: 0, z: 0, lx: 0, lz: 0 };

export class PaperTrails {
  private readonly trails: Trail[] = [];
  private readonly following = new Map<Snowball, Follow>();
  private serial = 0;
  /** Metres between cells: one square of the flap, so each cell is one repeat of its texture. */
  private readonly step: number;

  constructor(
    private readonly scene: Scene,
    private readonly parts: PaperParts,
    private readonly support: SupportQuery,
  ) {
    this.step = Math.min(0.2, Math.max(0.06, parts.shape?.sheetLength ?? 0.1));
  }

  /** Follows every roll of toilet paper in the field, leaving paper behind it. `alpha` is the draw's place in the physics step. */
  sync(field: SnowballField, dt: number, alpha: number): void {
    if (this.parts.shape !== undefined) {
      for (const ball of field.balls) {
        if (ball.spent || itemOfBall(ball) !== ItemType.ToiletPaper) continue;
        this.follow(ball, alpha);
      }
      for (const ball of this.following.keys()) {
        if (!ball.spent && field.balls.includes(ball)) continue;
        this.following.delete(ball);
      }
    }
    for (const trail of this.trails) {
      if (trail.count === 0) continue;
      trail.update(dt, this.support);
      if (trail.gone) trail.stop();
    }
  }

  private follow(ball: Snowball, alpha: number): void {
    const x = ball.prevX + (ball.x - ball.prevX) * alpha;
    const y = ball.prevY + (ball.y - ball.prevY) * alpha;
    const z = ball.prevZ + (ball.z - ball.prevZ) * alpha;
    let state = this.following.get(ball);
    if (state === undefined) {
      state = { trail: undefined, lastX: x, lastY: y, lastZ: z, carry: 0, lx: 1, lz: 0 };
      this.following.set(ball, state);
      return;
    }
    const dx = x - state.lastX;
    const dy = y - state.lastY;
    const dz = z - state.lastZ;
    const distance = Math.hypot(dx, dy, dz);
    if (distance < 1e-4) return;
    // The ribbon lies across the way the roll goes. Straight up or down it keeps the way it was lying.
    const flat = Math.hypot(dx, dz);
    if (flat > 1e-3) {
      state.lx = dz / flat;
      state.lz = -dx / flat;
    }
    if (distance > 12) {
      // A jump (it was picked up and put down, or the world moved): no paper across the gap.
      state.lastX = x;
      state.lastY = y;
      state.lastZ = z;
      state.carry = 0;
      state.trail = undefined;
      return;
    }

    const speedX = ball.vx;
    const speedY = ball.vy;
    const speedZ = ball.vz;
    let along = this.step - state.carry;
    let placed = 0;
    while (along <= distance && placed < MAX_PER_FRAME) {
      const f = along / distance;
      this.put(
        state,
        state.lastX + dx * f,
        state.lastY + dy * f,
        state.lastZ + dz * f,
        ball.radius,
        speedX,
        speedY,
        speedZ,
      );
      along += this.step;
      placed++;
    }
    state.carry = Math.min(this.step, distance - (along - this.step));
    state.lastX = x;
    state.lastY = y;
    state.lastZ = z;
  }

  /** Lays one cell's end at (x, y, z), where the roll's middle is. */
  private put(state: Follow, x: number, y: number, z: number, radius: number, vx: number, vy: number, vz: number): void {
    let trail = state.trail;
    if (trail === undefined || trail.full) {
      const previous = trail;
      if (previous !== undefined) previous.lastSample(carried);
      trail = this.take();
      state.trail = trail;
      // A fresh mesh carries on from where the last one stopped, so there is no gap.
      if (previous !== undefined) {
        trail.add(carried.x, carried.y, carried.z, carried.lx, carried.lz, 0, 0, 0, this.support);
      }
    }
    const ground = this.support(x, y, z);
    const onSurface = y - radius - ground < ON_SURFACE;
    if (onSurface) {
      // Rolling: down on what it is rolling on, at the roll's contact point.
      trail.add(x, ground, z, state.lx, state.lz, 0, 0, 0, this.support);
    } else {
      // Flying: left in the air, to float down on its own.
      trail.add(
        x,
        y,
        z,
        state.lx,
        state.lz,
        vx * LEAVE_SHARE + (Math.random() - 0.5) * 2 * LEAVE_DRIFT,
        vy * LEAVE_SHARE,
        vz * LEAVE_SHARE + (Math.random() - 0.5) * 2 * LEAVE_DRIFT,
        undefined,
      );
    }
  }

  /** A trail mesh to write into: an unused one, a new one, or the oldest. */
  private take(): Trail {
    let chosen: Trail | undefined = this.trails.find((trail) => trail.count === 0);
    if (chosen === undefined && this.trails.length < MAX_TRAILS) {
      chosen = new Trail(this.parts, this.scene);
      this.trails.push(chosen);
    }
    if (chosen === undefined) {
      chosen = this.trails[0];
      for (const trail of this.trails) if (chosen !== undefined && trail.serial < chosen.serial) chosen = trail;
      // Whoever was writing into it starts a fresh one.
      for (const state of this.following.values()) if (state.trail === chosen) state.trail = undefined;
    }
    const taken = chosen as Trail;
    taken.start(++this.serial);
    return taken;
  }

  dispose(): void {
    for (const trail of this.trails) trail.dispose(this.scene);
    this.trails.length = 0;
    this.following.clear();
  }
}
