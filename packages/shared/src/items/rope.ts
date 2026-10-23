import type { SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import {
  elasticForce,
  type ElasticBounds,
  type ElasticCollider,
  type ElasticMaterial,
} from "../sim/elastic.ts";
import { PLAYER_MASS, PlayerMode, type Player } from "../sim/player.ts";
import type { Snowball } from "./snowball.ts";

/**
 * Rope: the gmod tool-gun rope and elastic, as a game item.
 *
 * A rope is a chain of straight segments joined at free hinges (the joins are
 * where it bends), with an end tied to each of two things. An end is tied
 * either to a fixed point (ground, a tree) or to a {@link RopeBody}, a thing
 * that moves (a snowball, a felled log): the rope end follows it, and when the
 * rope is stretched past its length it pulls on it. The player is one too
 * ({@link PlayerRopeBody}): a string tied at one end and held in the hand at the
 * other pulls the walker up short, and drags whatever it is tied to.
 *
 * The chain is simulated with position-based dynamics, compliance included
 * (XPBD): a segment resists being stretched with a stiffness from the
 * {@link RopeSpec}, never resists being squashed, so a rope with slack sags
 * and lies on the ground, and a taut one is a spring. The xmas lights are the
 * stiff, basic spec; the later elastic rope is another spec with a lower
 * stiffness and longer reach, and nothing else here changes.
 *
 * Lives in shared (no DOM, no three.js): the server will run it.
 */

export interface RopeSpec extends ElasticMaterial {
  /** Straight pieces the rope is made of; it bends between them. */
  readonly segments: number;
  /** A rope tied closer than `segments * minSegmentLength` is refused (0: no minimum). */
  readonly minSegmentLength: number;
  /** The farthest apart its ends can be tied: `segments * maxSegmentLength`. */
  readonly maxSegmentLength: number;
  /**
   * Extra length cut into the rope when it is tied, as a fraction of the gap.
   * Negative cuts it short, so it is stretched taut between its ends, like
   * elastic, with only a little sag.
   */
  readonly slack: number;
  /*
   * Its elasticity (`stiffness`, newtons per metre of stretch for the rope as a
   * whole; `maxStrain`, how far it stretches before it goes hard; `maxForce`,
   * the most it pulls or pushes with) is an ElasticMaterial: the same law any
   * elastic thing in the game follows, see sim/elastic.ts.
   */
  /** Kilograms, the whole rope. */
  readonly mass: number;
  /** Metres from the rope's centreline within which it is touching something. */
  readonly radius: number;
}

/**
 * Three red-green-blue sets of the lights, nine bulbs in a row, with a bulb
 * every segment. Each segment is 0.1m as modelled (xmaslights.glb) and is
 * drawn stretched to whatever the gap needs, up to 5m end to end. There is
 * no minimum gap: tied end to end it just lies in a heap.
 */
export const XMAS_LIGHTS: RopeSpec = {
  segments: 9,
  minSegmentLength: 0,
  maxSegmentLength: 5 / 9,
  slack: -0.01,
  stiffness: 1200,
  maxStrain: 0.4,
  maxForce: 900,
  mass: 0.45,
  radius: 0.02,
};

/** Most strings of lights that can be run together into one long rope. */
export const ROPE_MAX_STRINGS = 6;

const chainSpecs = new Map<number, RopeSpec>();

/**
 * `strings` strings of xmas lights joined end to end as one rope: more
 * segments, more mass, and that much more reach.
 */
export function ropeSpecFor(spec: RopeSpec, strings: number): RopeSpec {
  if (strings <= 1) return spec;
  let chain = chainSpecs.get(strings);
  if (chain === undefined || chain.radius !== spec.radius) {
    chain = {
      ...spec,
      segments: spec.segments * strings,
      mass: spec.mass * strings,
    };
    chainSpecs.set(strings, chain);
  }
  return chain;
}

export const RopePlan = {
  Ok: 0,
  /** Tied too close together for the string to fit between. */
  TooShort: 1,
  /** Tied farther apart than the string reaches. */
  TooLong: 2,
} as const;
export type RopePlan = (typeof RopePlan)[keyof typeof RopePlan];

export function ropeMaxReach(spec: RopeSpec): number {
  return spec.segments * spec.maxSegmentLength;
}

export function ropeMinReach(spec: RopeSpec): number {
  return spec.segments * spec.minSegmentLength;
}

/** The string is never cut shorter than this, so two ends tied together still have a heap of it. */
const MIN_STRING_LENGTH = 0.09;

/** Whether ends `distance` apart can be tied, and how long the string is then. */
export function planRope(
  spec: RopeSpec,
  distance: number,
): { readonly plan: RopePlan; readonly length: number } {
  const length = Math.max(MIN_STRING_LENGTH, distance * (1 + spec.slack));
  if (distance < ropeMinReach(spec)) return { plan: RopePlan.TooShort, length };
  if (distance > ropeMaxReach(spec)) return { plan: RopePlan.TooLong, length };
  return { plan: RopePlan.Ok, length };
}

export interface RopeVec {
  x: number;
  y: number;
  z: number;
}

/** A moving thing a rope end can be tied to. */
export interface RopeBody {
  /** Where the end is tied, written into `out`; false once the thing is gone. */
  tiePoint(out: RopeVec): boolean;
  /** How fast the tie point is moving, m/s. */
  tieVelocity(out: RopeVec): void;
  /** Kilograms. */
  readonly mass: number;
  /** An impulse (N*s) at the tie point: the rope pulling. */
  push(ix: number, iy: number, iz: number): void;
  /** The most force the rope pulls this body with, newtons; the spec's `maxForce` if absent. */
  readonly maxPull?: number;
  /**
   * A collider the rope passes through without touching, because this body is
   * it: a rope held in the player's hand does not push on the player's own box.
   */
  readonly exempt?: ElasticCollider | undefined;
}

/** Where one end of a rope is tied: a point in the world, or a thing that moves. */
export interface RopeTie {
  x: number;
  y: number;
  z: number;
  body?: RopeBody | undefined;
}

const GRAVITY = 9.81;
/** Per second; air and the string's own friction. */
const AIR_DRAG = 1.4;
const SOLVER_ITERATIONS = 12;
/** How far out of solid ground the search for the nearest way out goes, in voxels. */
const EXIT_SEARCH = 6;
/** A node touching something keeps this much of its sliding speed per step. */
const CONTACT_GRIP = 0.85;
/** Up is the preferred way out of the ground; down the least. */
const EXIT_UP_BIAS = 0.7;
const EXIT_DOWN_BIAS = 1.6;
/** The most speed one step of pulling gives a tied body, m/s: keeps a light thing from being flung. */
const MAX_PULL_DV = 2;
/** Damping on the pull, as a fraction of critical for the body tied on. */
const PULL_DAMPING = 0.3;
/** The most speed one step of pushing gives a collider, m/s. */
const MAX_PUSH_DV = 1;
/** A string with neither end tied lies about this long, then is gone. */
const LOOSE_SECONDS = 20;

const DIRECTIONS: readonly (readonly [number, number, number])[] = [
  [0, 1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
  [0, -1, 0],
];

const tie = { x: 0, y: 0, z: 0 };
const tieVel = { x: 0, y: 0, z: 0 };
const exit = { x: 0, y: 0, z: 0 };
const push = { x: 0, y: 0, z: 0 };
const bounds: ElasticBounds = { x: 0, y: 0, z: 0, radius: 0 };
const NO_COLLIDERS: readonly ElasticCollider[] = [];

export class Rope {
  /** Node positions, x y z each; `segments + 1` of them. Mutated in place every step. */
  readonly positions: Float64Array;
  private readonly previous: Float64Array;
  private readonly inverseMass: Float64Array;
  private readonly lambda: Float64Array;
  private colliders: readonly ElasticCollider[] = NO_COLLIDERS;
  /** Per node: 1 + the index of the collider holding it out of its line this step, or 0. */
  private readonly contact: Uint8Array;
  /** Rest length of one segment, metres. */
  readonly segmentLength: number;
  readonly nodeCount: number;
  private readonly freeInverseMass: number;
  private readonly ties: [RopeTie, RopeTie];
  /** Seconds since both ends were last tied to something. */
  private looseFor = 0;
  /** Tension in the rope at each end the last step, newtons. For effects, and tests. */
  readonly tension: [number, number] = [0, 0];

  constructor(
    readonly id: number,
    readonly spec: RopeSpec,
    a: RopeTie,
    b: RopeTie,
    /** The string's whole length, from {@link planRope}. */
    readonly length: number,
  ) {
    const nodes = spec.segments + 1;
    this.nodeCount = nodes;
    this.segmentLength = length / spec.segments;
    this.positions = new Float64Array(nodes * 3);
    this.previous = new Float64Array(nodes * 3);
    this.inverseMass = new Float64Array(nodes);
    this.lambda = new Float64Array(spec.segments);
    this.contact = new Uint8Array(nodes);
    this.freeInverseMass = nodes / spec.mass;
    this.ties = [{ ...a }, { ...b }];

    for (let i = 0; i < nodes; i++) {
      const t = i / (nodes - 1);
      this.positions[i * 3] = a.x + (b.x - a.x) * t;
      this.positions[i * 3 + 1] = a.y + (b.y - a.y) * t;
      this.positions[i * 3 + 2] = a.z + (b.z - a.z) * t;
      this.inverseMass[i] = this.freeInverseMass;
    }
    this.inverseMass[0] = 0;
    this.inverseMass[nodes - 1] = 0;
    this.previous.set(this.positions);
  }

  /** The rope is done: nothing holds it any more and it has lain there a while. */
  get expired(): boolean {
    return this.looseFor >= LOOSE_SECONDS;
  }

  /** True while an end is tied to something. */
  isTied(end: 0 | 1): boolean {
    return this.inverseMass[end === 0 ? 0 : this.nodeCount - 1] === 0;
  }

  /** Where end 0 or 1 is tied, if it is still tied. */
  tiedAt(end: 0 | 1, out: RopeVec): boolean {
    if (!this.isTied(end)) return false;
    const node = end === 0 ? 0 : this.nodeCount - 1;
    out.x = this.positions[node * 3] ?? 0;
    out.y = this.positions[node * 3 + 1] ?? 0;
    out.z = this.positions[node * 3 + 2] ?? 0;
    return true;
  }

  /**
   * How hard the rope pulls back along its length right now, newtons: the
   * elastic law applied to how much longer it is than it was cut. Even all
   * along it, as in any cord with nothing gripping it.
   */
  get stretchForce(): number {
    const pos = this.positions;
    let current = 0;
    for (let s = 0; s < this.spec.segments; s++) {
      const a = s * 3;
      current += Math.hypot(
        (pos[a + 3] ?? 0) - (pos[a] ?? 0),
        (pos[a + 4] ?? 0) - (pos[a + 1] ?? 0),
        (pos[a + 5] ?? 0) - (pos[a + 2] ?? 0),
      );
    }
    return elasticForce(this.spec, this.length, current - this.length);
  }

  /** One fixed substep. `colliders` are the moving things it is pushed by, and pushes back on. */
  step(dt: number, query: SolidQuery, colliders: readonly ElasticCollider[] = NO_COLLIDERS): void {
    const n = this.nodeCount;
    const pos = this.positions;
    const prev = this.previous;
    const w = this.inverseMass;

    // Ends follow whatever they are tied to; one tied to a thing that has gone lets go.
    for (let end = 0; end < 2; end++) {
      const t = this.ties[end];
      if (t === undefined) continue;
      const node = end === 0 ? 0 : n - 1;
      if (t.body !== undefined) {
        if (t.body.tiePoint(tie)) {
          t.x = tie.x;
          t.y = tie.y;
          t.z = tie.z;
        } else {
          t.body = undefined;
          w[node] = this.freeInverseMass;
          prev[node * 3] = pos[node * 3] ?? 0;
          prev[node * 3 + 1] = pos[node * 3 + 1] ?? 0;
          prev[node * 3 + 2] = pos[node * 3 + 2] ?? 0;
          continue;
        }
      }
      if (w[node] === 0) {
        pos[node * 3] = t.x;
        pos[node * 3 + 1] = t.y;
        pos[node * 3 + 2] = t.z;
      }
    }
    this.looseFor = w[0] !== 0 && w[n - 1] !== 0 ? this.looseFor + dt : 0;

    // Predict.
    const keep = Math.exp(-AIR_DRAG * dt);
    const fall = GRAVITY * dt * dt;
    for (let i = 0; i < n; i++) {
      if (w[i] === 0) continue;
      const k = i * 3;
      const x = pos[k] ?? 0;
      const y = pos[k + 1] ?? 0;
      const z = pos[k + 2] ?? 0;
      pos[k] = x + (x - (prev[k] ?? 0)) * keep;
      pos[k + 1] = y + (y - (prev[k + 1] ?? 0)) * keep - fall;
      pos[k + 2] = z + (z - (prev[k + 2] ?? 0)) * keep;
      prev[k] = x;
      prev[k + 1] = y;
      prev[k + 2] = z;
    }

    this.lambda.fill(0);
    this.contact.fill(0);
    this.colliders = colliders;
    this.solve(dt, SOLVER_ITERATIONS);
    this.collide(query);
    this.collideColliders(colliders);
    this.solve(dt, 3);
    this.collide(query);
    this.collideColliders(colliders);

    this.pullOnBodies(dt);
    this.pushOnColliders(colliders, dt);
  }

  /** True for a collider that is one of the things this rope is tied to. */
  private isExempt(collider: ElasticCollider): boolean {
    return this.ties[0].body?.exempt === collider || this.ties[1].body?.exempt === collider;
  }

  /**
   * Lays this rope along the shape of another one (a longer or shorter one that
   * it replaces), by how far along each is, so extending a rope does not make it
   * jump. Nodes keep no speed.
   */
  seedFrom(other: Rope): void {
    const from = other.positions;
    const last = other.nodeCount - 1;
    for (let i = 0; i < this.nodeCount; i++) {
      const at = (i / (this.nodeCount - 1)) * last;
      const j = Math.min(last - 1, Math.floor(at));
      const f = at - j;
      for (let axis = 0; axis < 3; axis++) {
        const a = from[j * 3 + axis] ?? 0;
        const b = from[(j + 1) * 3 + axis] ?? 0;
        this.positions[i * 3 + axis] = a + (b - a) * f;
      }
    }
    this.previous.set(this.positions);
  }

  /**
   * Pushes free nodes, and the middle of each segment, out of the colliders,
   * and remembers which collider holds each one out. The rope goes round the
   * thing, longer than it was: that stretch is what pushes back, in
   * {@link pushOnColliders}.
   */
  private collideColliders(colliders: readonly ElasticCollider[]): void {
    const pos = this.positions;
    const prev = this.previous;
    const w = this.inverseMass;
    const radius = this.spec.radius;
    const n = this.nodeCount;

    for (let c = 0; c < colliders.length; c++) {
      const collider = colliders[c];
      if (collider === undefined || this.isExempt(collider) || !collider.bounds(bounds)) continue;
      const near = bounds.radius + radius + 0.05;

      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        const k = i * 3;
        const x = pos[k] ?? 0;
        const y = pos[k + 1] ?? 0;
        const z = pos[k + 2] ?? 0;
        if (Math.abs(x - bounds.x) > near || Math.abs(z - bounds.z) > near || Math.abs(y - bounds.y) > near) continue;
        if (!collider.pushOut(x, y, z, radius, push)) continue;
        this.settleNode(k, push.x, push.y, push.z, pos, prev);
        this.contact[i] = c + 1;
      }

      for (let s = 0; s < this.spec.segments; s++) {
        const a = s * 3;
        const b = a + 3;
        const mx = ((pos[a] ?? 0) + (pos[b] ?? 0)) / 2;
        const my = ((pos[a + 1] ?? 0) + (pos[b + 1] ?? 0)) / 2;
        const mz = ((pos[a + 2] ?? 0) + (pos[b + 2] ?? 0)) / 2;
        if (Math.abs(mx - bounds.x) > near || Math.abs(mz - bounds.z) > near || Math.abs(my - bounds.y) > near) continue;
        if (!collider.pushOut(mx, my, mz, radius, push)) continue;
        const aFree = (w[s] ?? 0) !== 0;
        const bFree = (w[s + 1] ?? 0) !== 0;
        if (!aFree && !bFree) continue;
        const share = aFree && bFree ? 1 : 2;
        if (aFree) {
          this.settleNode(a, push.x * share, push.y * share, push.z * share, pos, prev);
          this.contact[s] = c + 1;
        }
        if (bFree) {
          this.settleNode(b, push.x * share, push.y * share, push.z * share, pos, prev);
          this.contact[s + 1] = c + 1;
        }
      }
    }
  }

  /**
   * The rope's reaction on whatever holds it out of its line: each node held
   * by a collider is being pulled back toward its neighbours by the rope's
   * tension, and the collider is pushed back with that force. Straight across
   * the node it cancels; the more it is bent round the thing, and the more
   * stretched, the harder it pushes.
   */
  private pushOnColliders(colliders: readonly ElasticCollider[], dt: number): void {
    if (colliders.length === 0) return;
    const tension = this.stretchForce;
    if (tension <= 0) return;
    const pos = this.positions;
    const n = this.nodeCount;

    for (let c = 0; c < colliders.length; c++) {
      const collider = colliders[c];
      if (collider === undefined || this.isExempt(collider)) continue;
      let fx = 0;
      let fy = 0;
      let fz = 0;
      for (let i = 0; i < n; i++) {
        if (this.contact[i] !== c + 1) continue;
        const k = i * 3;
        for (let side = -1; side <= 1; side += 2) {
          const j = i + side;
          if (j < 0 || j >= n) continue;
          const dx = (pos[j * 3] ?? 0) - (pos[k] ?? 0);
          const dy = (pos[j * 3 + 1] ?? 0) - (pos[k + 1] ?? 0);
          const dz = (pos[j * 3 + 2] ?? 0) - (pos[k + 2] ?? 0);
          const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (len < 1e-9) continue;
          fx += (dx / len) * tension;
          fy += (dy / len) * tension;
          fz += (dz / len) * tension;
        }
      }
      const force = Math.sqrt(fx * fx + fy * fy + fz * fz);
      if (force < 1e-9) continue;
      // Not capped by `maxForce`: the elastic law already stops a runner by going hard at the max
      // strain. Only a guard against one step throwing a light thing across the map.
      const limited = Math.min(1, (collider.mass * MAX_PUSH_DV) / (force * dt));
      collider.push(fx * limited * dt, fy * limited * dt, fz * limited * dt);
    }
  }

  /** XPBD distance constraints that only ever shorten a segment. */
  private solve(dt: number, iterations: number): void {
    const pos = this.positions;
    const w = this.inverseMass;
    const rest = this.segmentLength;
    // Compliance of one segment is the inverse of its stiffness: the
    // whole rope is a chain of `segments` springs in series.
    const stiffness = this.spec.stiffness * this.spec.segments;
    const compliance = 1 / (stiffness * dt * dt);
    const lambda = this.lambda;

    for (let it = 0; it < iterations; it++) {
      for (let s = 0; s < this.spec.segments; s++) {
        const a = s * 3;
        const b = a + 3;
        const dx = (pos[a] ?? 0) - (pos[b] ?? 0);
        const dy = (pos[a + 1] ?? 0) - (pos[b + 1] ?? 0);
        const dz = (pos[a + 2] ?? 0) - (pos[b + 2] ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist <= rest || dist < 1e-9) continue;
        const wa = w[s] ?? 0;
        const wb = w[s + 1] ?? 0;
        const sum = wa + wb;
        if (sum === 0) continue;
        const c = dist - rest;
        const lam = lambda[s] ?? 0;
        const delta = (-c - compliance * lam) / (sum + compliance);
        lambda[s] = lam + delta;
        const nx = (dx / dist) * delta;
        const ny = (dy / dist) * delta;
        const nz = (dz / dist) * delta;
        pos[a] = (pos[a] ?? 0) + nx * wa;
        pos[a + 1] = (pos[a + 1] ?? 0) + ny * wa;
        pos[a + 2] = (pos[a + 2] ?? 0) + nz * wa;
        pos[b] = (pos[b] ?? 0) - nx * wb;
        pos[b + 1] = (pos[b + 1] ?? 0) - ny * wb;
        pos[b + 2] = (pos[b + 2] ?? 0) - nz * wb;
      }
      // A stretched rope pulls hard toward its line: held out of the colliders
      // after every pass, it cannot be dragged through one between passes.
      if (this.colliders.length > 0) this.collideColliders(this.colliders);
    }
  }

  /** Keeps free nodes, and the middle of each segment, out of solid ground. */
  private collide(query: SolidQuery): void {
    const pos = this.positions;
    const prev = this.previous;
    const w = this.inverseMass;
    const radius = this.spec.radius;

    for (let i = 0; i < this.nodeCount; i++) {
      if (w[i] === 0) continue;
      const k = i * 3;
      if (!pushOut(query, pos[k] ?? 0, pos[k + 1] ?? 0, pos[k + 2] ?? 0, radius, exit)) continue;
      this.settleNode(k, exit.x, exit.y, exit.z, pos, prev);
    }

    // A segment can lie across a corner, or a trunk thinner than its length,
    // with neither end inside it: check the middle too and move both ends.
    for (let s = 0; s < this.spec.segments; s++) {
      const a = s * 3;
      const b = a + 3;
      const mx = ((pos[a] ?? 0) + (pos[b] ?? 0)) / 2;
      const my = ((pos[a + 1] ?? 0) + (pos[b + 1] ?? 0)) / 2;
      const mz = ((pos[a + 2] ?? 0) + (pos[b + 2] ?? 0)) / 2;
      if (!pushOut(query, mx, my, mz, radius, exit)) continue;
      const aFree = (w[s] ?? 0) !== 0;
      const bFree = (w[s + 1] ?? 0) !== 0;
      if (!aFree && !bFree) continue;
      // Moving the middle by d moves each free end by d, or by 2d if it is the only one.
      const share = aFree && bFree ? 1 : 2;
      if (aFree) this.settleNode(a, exit.x * share, exit.y * share, exit.z * share, pos, prev);
      if (bFree) this.settleNode(b, exit.x * share, exit.y * share, exit.z * share, pos, prev);
    }
  }

  /** Moves a node out by `d`, losing the speed it had into the surface and some of what it slid with. */
  private settleNode(
    k: number,
    dx: number,
    dy: number,
    dz: number,
    pos: Float64Array,
    prev: Float64Array,
  ): void {
    pos[k] = (pos[k] ?? 0) + dx;
    pos[k + 1] = (pos[k + 1] ?? 0) + dy;
    pos[k + 2] = (pos[k + 2] ?? 0) + dz;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;
    let vx = (pos[k] ?? 0) - (prev[k] ?? 0) - dx;
    let vy = (pos[k + 1] ?? 0) - (prev[k + 1] ?? 0) - dy;
    let vz = (pos[k + 2] ?? 0) - (prev[k + 2] ?? 0) - dz;
    const into = vx * nx + vy * ny + vz * nz;
    if (into < 0) {
      vx -= into * nx;
      vy -= into * ny;
      vz -= into * nz;
    }
    prev[k] = (pos[k] ?? 0) - vx * CONTACT_GRIP;
    prev[k + 1] = (pos[k + 1] ?? 0) - vy * CONTACT_GRIP;
    prev[k + 2] = (pos[k + 2] ?? 0) - vz * CONTACT_GRIP;
  }

  /**
   * Pulls each tied body toward the rope. The pull is the tension of the whole
   * rope (how much longer than it was cut it now is), the same at both ends, as
   * in any cord; the segment at the end alone would read too high or too low on
   * a long chain while the stretch is still travelling along it.
   */
  private pullOnBodies(dt: number): void {
    const pos = this.positions;
    const prev = this.previous;
    const n = this.nodeCount;
    const stiffness = this.spec.stiffness * this.spec.segments;
    const anyBody = this.ties[0].body !== undefined || this.ties[1].body !== undefined;
    const tension = anyBody ? this.stretchForce : 0;
    for (let end = 0; end < 2; end++) {
      const t = this.ties[end];
      const node = end === 0 ? 0 : n - 1;
      const next = end === 0 ? 1 : n - 2;
      const a = node * 3;
      const b = next * 3;
      const dx = (pos[b] ?? 0) - (pos[a] ?? 0);
      const dy = (pos[b + 1] ?? 0) - (pos[a + 1] ?? 0);
      const dz = (pos[b + 2] ?? 0) - (pos[a + 2] ?? 0);
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const stretch = dist - this.segmentLength;
      let force = stretch > 0 ? stiffness * stretch : 0;

      if (t?.body !== undefined && tension > 0 && dist > 1e-9) {
        const body = t.body;
        force = tension;
        const ux = dx / dist;
        const uy = dy / dist;
        const uz = dz / dist;
        body.tieVelocity(tieVel);
        // How fast the neighbouring node is moving away from the tie point.
        const away =
          (((pos[b] ?? 0) - (prev[b] ?? 0)) / dt - tieVel.x) * ux +
          (((pos[b + 1] ?? 0) - (prev[b + 1] ?? 0)) / dt - tieVel.y) * uy +
          (((pos[b + 2] ?? 0) - (prev[b + 2] ?? 0)) / dt - tieVel.z) * uz;
        const mass = body.mass;
        force += 2 * PULL_DAMPING * Math.sqrt(this.spec.stiffness * mass) * away;
        force = Math.min(body.maxPull ?? this.spec.maxForce, Math.max(0, force));
        this.tension[end] = force;
        if (force > 0) {
          const impulse = Math.min(force * dt, mass * MAX_PULL_DV);
          body.push(ux * impulse, uy * impulse, uz * impulse);
        }
      } else {
        this.tension[end] = Math.min(this.spec.maxForce, force);
      }
    }
  }
}

/**
 * If the point is inside solid ground, the shortest way out of it (ground
 * first, then sideways, never down unless it must be) written into `out`.
 */
function pushOut(
  query: SolidQuery,
  x: number,
  y: number,
  z: number,
  radius: number,
  out: RopeVec,
): boolean {
  const vx = Math.floor(x / VOXEL_SIZE);
  const vy = Math.floor(y / VOXEL_SIZE);
  const vz = Math.floor(z / VOXEL_SIZE);
  if (!query.isSolid(vx, vy, vz)) return false;

  let best = Infinity;
  out.x = 0;
  out.y = EXIT_SEARCH * VOXEL_SIZE;
  out.z = 0;
  for (const [dx, dy, dz] of DIRECTIONS) {
    for (let k = 1; k <= EXIT_SEARCH; k++) {
      if (query.isSolid(vx + dx * k, vy + dy * k, vz + dz * k)) continue;
      // Distance to the near face of the first open voxel, plus the string's own radius.
      const face = (v: number, d: number): number => (d > 0 ? (v + k) * VOXEL_SIZE : (v - k + 1) * VOXEL_SIZE);
      let distance = radius;
      if (dx !== 0) distance += Math.abs(face(vx, dx) - x);
      else if (dy !== 0) distance += Math.abs(face(vy, dy) - y);
      else distance += Math.abs(face(vz, dz) - z);
      const bias = dy > 0 ? EXIT_UP_BIAS : dy < 0 ? EXIT_DOWN_BIAS : 1;
      if (distance * bias < best) {
        best = distance * bias;
        out.x = dx * distance;
        out.y = dy * distance;
        out.z = dz * distance;
      }
      break;
    }
  }
  return true;
}

/** Most strings lying about at once; tying another loses the oldest. */
export const MAX_ROPES = 64;

/** Every tied rope in the world. */
export class RopeField {
  readonly ropes: Rope[] = [];
  private nextId = 1;

  add(spec: RopeSpec, a: RopeTie, b: RopeTie, length: number): Rope {
    if (this.ropes.length >= MAX_ROPES) this.ropes.shift();
    const rope = new Rope(this.nextId++, spec, a, b, length);
    this.ropes.push(rope);
    return rope;
  }

  /**
   * One fixed substep. Ropes tied far from the player are left as they lie.
   * `colliders` are the moving things ropes push against and are pushed by.
   */
  step(
    dt: number,
    query: SolidQuery,
    playerX: number,
    playerZ: number,
    farDistance: number,
    colliders: readonly ElasticCollider[] = NO_COLLIDERS,
  ): void {
    const farSq = farDistance * farDistance;
    for (let i = this.ropes.length - 1; i >= 0; i--) {
      const rope = this.ropes[i];
      if (rope === undefined) continue;
      if (rope.expired) {
        this.ropes.splice(i, 1);
        continue;
      }
      const dx = (rope.positions[0] ?? 0) - playerX;
      const dz = (rope.positions[2] ?? 0) - playerZ;
      if (dx * dx + dz * dz > farSq) continue;
      rope.step(dt, query, colliders);
    }
  }

  /** Takes a rope out of the world, e.g. picked up. */
  remove(rope: Rope): boolean {
    const i = this.ropes.indexOf(rope);
    if (i < 0) return false;
    this.ropes.splice(i, 1);
    return true;
  }

  /**
   * The rope a ray passes nearest to, within `PICK_RADIUS` of its string and
   * `maxDistance` along the ray. `out.distance` is how far along the ray
   * the nearest approach to that rope is.
   */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: RopeHit,
  ): Rope | undefined {
    let best: Rope | undefined;
    let bestAlong = Infinity;
    for (const rope of this.ropes) {
      const p = rope.positions;
      for (let i = 0; i < rope.spec.segments; i++) {
        const a = i * 3;
        const ux = (p[a + 3] ?? 0) - (p[a] ?? 0);
        const uy = (p[a + 4] ?? 0) - (p[a + 1] ?? 0);
        const uz = (p[a + 5] ?? 0) - (p[a + 2] ?? 0);
        const wx = (p[a] ?? 0) - ox;
        const wy = (p[a + 1] ?? 0) - oy;
        const wz = (p[a + 2] ?? 0) - oz;
        const uu = ux * ux + uy * uy + uz * uz;
        const ud = ux * dx + uy * dy + uz * dz;
        const uw = ux * wx + uy * wy + uz * wz;
        const dw = dx * wx + dy * wy + dz * wz;
        // Closest points of a ray and a segment: clamp one, solve the other, clamp, solve back.
        let s = 0;
        if (uu > 1e-12) {
          const denom = uu - ud * ud;
          s = denom > 1e-9 ? (ud * dw - uw) / denom : 0;
          s = Math.min(1, Math.max(0, s));
        }
        let t = Math.min(maxDistance, Math.max(0, dw + s * ud));
        if (uu > 1e-12) s = Math.min(1, Math.max(0, (t * ud - uw) / uu));
        t = Math.min(maxDistance, Math.max(0, dw + s * ud));
        const qx = (p[a] ?? 0) + ux * s - (ox + dx * t);
        const qy = (p[a + 1] ?? 0) + uy * s - (oy + dy * t);
        const qz = (p[a + 2] ?? 0) + uz * s - (oz + dz * t);
        if (qx * qx + qy * qy + qz * qz > PICK_RADIUS * PICK_RADIUS) continue;
        if (t < bestAlong) {
          bestAlong = t;
          best = rope;
        }
      }
    }
    out.distance = best === undefined ? 0 : bestAlong;
    return best;
  }

  clear(): void {
    this.ropes.length = 0;
  }
}

/** How near a ray must pass to a string to be pointing at it, metres. */
export const PICK_RADIUS = 0.18;

export interface RopeHit {
  /** Along the ray to the nearest approach, metres. */
  distance: number;
}

/** The rope is tied just under the ball's surface so it does not look pinned to the air. */
const TIE_DEPTH = 0.95;
/** A settled ball is woken by a pull that would move it faster than this, m/s. */
const WAKE_SPEED = 0.03;

/**
 * A rope end tied to a rolling ball, at the spot it was aimed at: a snowball,
 * a rock. Its weight is the ball's own, so a rock is hard to drag and a
 * snowball is not.
 */
export class BallRopeBody implements RopeBody {
  private readonly dx: number;
  private readonly dy: number;
  private readonly dz: number;

  constructor(
    private readonly ball: Snowball,
    hitX: number,
    hitY: number,
    hitZ: number,
  ) {
    const ox = hitX - ball.x;
    const oy = hitY - ball.y;
    const oz = hitZ - ball.z;
    const len = Math.hypot(ox, oy, oz);
    // Straight up if the hit was dead centre; it cannot be, but a NaN would stay.
    this.dx = len > 1e-6 ? ox / len : 0;
    this.dy = len > 1e-6 ? oy / len : 1;
    this.dz = len > 1e-6 ? oz / len : 0;
  }

  get mass(): number {
    return this.ball.mass;
  }

  tiePoint(out: RopeVec): boolean {
    const ball = this.ball;
    if (ball.spent) return false;
    const reach = ball.radius * TIE_DEPTH;
    out.x = ball.x + this.dx * reach;
    out.y = ball.y + this.dy * reach;
    out.z = ball.z + this.dz * reach;
    return true;
  }

  tieVelocity(out: RopeVec): void {
    out.x = this.ball.vx;
    out.y = this.ball.vy;
    out.z = this.ball.vz;
  }

  push(ix: number, iy: number, iz: number): void {
    const ball = this.ball;
    const mass = this.mass;
    const dvx = ix / mass;
    const dvy = iy / mass;
    const dvz = iz / mass;
    if (!ball.rolling) {
      if (Math.hypot(dvx, dvy, dvz) < WAKE_SPEED) return;
      ball.wake();
    }
    ball.vx += dvx;
    ball.vy += dvy;
    ball.vz += dvz;
  }
}

/** Where a rope held in the hand is tied, metres above the feet: about the belt. */
const HAND_HEIGHT = 1;
/** ...and how far in front of the player's middle. */
const HAND_FORWARD = 0.4;
/**
 * The most a rope pulls a player with, newtons. A walker leans against 1800 and
 * stops dead at the rope's max strain anyway (it hardens there, see
 * `HARDENING`); this is only the ceiling for a player thrown at the end of it.
 */
const PLAYER_MAX_PULL = 6000;

/**
 * A rope end held by the player: it is tied at their hand, follows them, and
 * pulls them back when the rope is stretched. The other end, tied to a rock,
 * drags the rock instead.
 */
export class PlayerRopeBody implements RopeBody {
  readonly mass = PLAYER_MASS;
  readonly maxPull = PLAYER_MAX_PULL;

  /**
   * `exempt` is the player's own {@link ElasticCollider} (PlayerBody): the rope is
   * held in their hand, so it does not push on their box.
   */
  constructor(
    private readonly player: Player,
    readonly exempt?: ElasticCollider,
  ) {}

  tiePoint(out: RopeVec): boolean {
    const p = this.player;
    if (p.mode === PlayerMode.Ragball) {
      out.x = p.x;
      out.y = p.y + p.ballRadius;
      out.z = p.z;
      return true;
    }
    const flat = Math.hypot(p.frontX, p.frontZ);
    const fx = flat > 1e-6 ? p.frontX / flat : 0;
    const fz = flat > 1e-6 ? p.frontZ / flat : 0;
    out.x = p.x + fx * HAND_FORWARD;
    out.y = p.y + HAND_HEIGHT;
    out.z = p.z + fz * HAND_FORWARD;
    return true;
  }

  tieVelocity(out: RopeVec): void {
    out.x = this.player.vx;
    out.y = this.player.vy;
    out.z = this.player.vz;
  }

  push(ix: number, iy: number, iz: number): void {
    this.player.applyImpulse(ix, iy, iz);
  }
}
