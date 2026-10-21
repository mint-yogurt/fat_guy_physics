import { createSphereCollision, sweepSphere, type SolidQuery } from "../sim/collision.ts";
import { VOXEL_SIZE } from "../sim/constants.ts";
import { groundTop } from "../sim/skate.ts";

/**
 * Snow: a held snowball, one rolled across the ground, and one in flight.
 *
 * The held item is a stack of `ItemType.Snowball`, one snowball a unit of
 * snow. Let go with left mouse and it is *rolled*: it leaves the item system
 * and becomes a `Snowball` here, a sphere that rolls over the terrain, picks
 * up snow where the ground is snowy and so grows (fast, and the faster it
 * goes the faster it grows, which is what a hill is for). Once it stops it
 * stays as a feature of the terrain rather than turning back into an item: it
 * can be hit for snow, shrinking in proportion as it gives it up, shoved
 * rolling again by anyone who walks into it, and is forgotten after a while
 * with nobody near it.
 *
 * Let go with right mouse and it is *put* overhand: a `Flying` snowball, a
 * fast, fairly flat throw that bursts on whatever it meets.
 *
 * Stepped on the fixed clock like the player, against the same solids.
 *
 * What rolls is not only snow. A {@link RollMaterial} says what a ball is made
 * of: how heavy for its size, how hard it is to keep rolling, whether it picks
 * up snow. The same ball, the same field and the same contact rules do for a
 * rock (items/rock.ts, `STONE`), which is heavy, does not grow, comes to rest
 * on a slope, and is shoved by what hits it in proportion to its weight.
 */

/** Radius of the item, and of a snowball that has only just been rolled. */
export const SNOW_UNIT_RADIUS = 0.112;
/**
 * Radius that is worth one unit of snow when it is rolled up: what a ball of
 * a given size gives back when hit. Not the item's own radius, so the item
 * can be drawn smaller without rolled snow getting any richer.
 */
export const SNOW_WORTH_RADIUS = 0.14;
/** Biggest a rolled snowball gets: about as tall as the player. */
export const SNOWBALL_MAX_RADIUS = 1.6;
/** Seconds a snowball is kept with nobody within render distance. */
export const SNOWBALL_DESPAWN_SECONDS = 300;

const GRAVITY = 18;
/**
 * A huge ball collides as a smaller one, sunk into the middle of it: sweeping
 * a sphere is cubic in its radius, and this is run every substep. The drawn
 * ball is lifted so it still sits on the ground; only a wall or a steep face
 * shows that it is the small one that touched.
 */
const PROXY_MAX_RADIUS = 0.7;
/** Metres of radius picked up per metre rolled on snow. */
const GROW_PER_METRE = 0.14;
const MIN_GROW_SPEED = 0.2;
/** Rolling resistance: slower going for a small ball, and a little that rises with speed. */
const ROLL_DRAG = 1.6;
const ROLL_DRAG_PROPORTIONAL = 0.05;
const REST_SPEED = 0.3;
/** Too gentle a slope to keep a slow ball moving. */
const REST_SLOPE = 0.1;
const REST_SECONDS = 0.5;
/** Rolls no longer than this, so one that somehow never stops still does. */
const MAX_ROLL_SECONDS = 60;
const FALL_LIMIT_Y = -5;
/**
 * Terrain is voxel stairs, whose treads are flat: a ball rolling over them
 * would feel almost nothing pulling it downhill. So the pull is read off the
 * ground a little way round the ball instead, as a board's is.
 */
const SLOPE_BLEND_PER_SECOND = 15;
/** How often a rolling ball asks whether the ground under it is snowy. */
const SNOW_CHECK_SECONDS = 0.25;
/**
 * How much bigger than a whole number of units a ball may be and still count
 * as that many: a ball a little over one unit across is still one snowball.
 */
const UNIT_SLACK = 0.25;
/** How much of the speed a walker closes on a ball with it takes away, a little over all of it. */
const PUSH_FACTOR = 1.05;
/** A ball going faster than this that loses half its speed to a contact is jammed. */
const BLOCKED_SPEED = 1;
const BLOCKED_SECONDS = 0.3;
/** Speed a ball keeps along the line of contact when it runs into another. */
const BALL_BOUNCE = 0.3;
/** A hit gives up about this fraction of the units a ball is worth, at least one. */
const HIT_FRACTION = 1 / 6;

/** What a rolling thing is made of. */
export interface RollMaterial {
  /** Kilograms per cubic metre, so a bigger one weighs more. */
  readonly density: number;
  /** Rolling resistance, m/s^2 for a ball a metre across (a smaller one is held back more). */
  readonly drag: number;
  /** A ground this gentle or gentler holds a slow ball still: how steep the slope is, rise over run. */
  readonly restSlope: number;
  /** The fraction of its landing speed it comes back up with. */
  readonly bounce: number;
  /** Rolled across snow it picks the snow up and grows. */
  readonly grows: boolean;
  /**
   * Has weight to speak of. A walker shoving it shares momentum with it
   * (and is slowed by it); it wakes when the ground goes from under it; and
   * it is not forgotten when nobody is near. Snow is too light to bother with
   * any of that.
   */
  readonly heavy: boolean;
}

export const SNOW: RollMaterial = {
  density: 115,
  drag: ROLL_DRAG,
  restSlope: REST_SLOPE,
  bounce: 0,
  grows: true,
  heavy: false,
};

/** Landing speed under which a bouncing ball does not bounce, m/s. */
const BOUNCE_MIN_SPEED = 2.5;
/** Seconds between checks that a lying heavy ball still has ground under it. */
const SUPPORT_CHECK_SECONDS = 0.5;
/** A lying rock is not woken by a knock that would send it off slower than this, m/s. */
const KNOCK_WAKE_SPEED = 0.05;
/** Most heavy balls (rocks) kept at once; past this the oldest thrown ones far from the player are dropped. */
const MAX_HEAVY_BALLS = 400;
/** The most speed a walker can lose to one shove, as a fraction of their own mass in m/s. */
const MAX_REACTION_SPEED = 1.5;

export type SnowAt = (x: number, z: number) => boolean;

/** Solid below (x, z) that is not terrain: a standing trunk, as a vertical cylinder. */
export interface Trunk {
  x: number;
  z: number;
  y0: number;
  y1: number;
  radius: number;
}

/**
 * A query with standing trunks added to it, for things that fly or roll away
 * from the player and so cannot rely on the trunks the main loop keeps solid
 * only near them. Rebuilt by whoever owns `trunks`, a frame at a time.
 */
export class TrunkQuery implements SolidQuery {
  readonly trunks: Trunk[] = [];

  constructor(private readonly base: SolidQuery) {}

  isSolid(vx: number, vy: number, vz: number): boolean {
    if (this.base.isSolid(vx, vy, vz)) return true;
    if (this.trunks.length === 0) return false;
    const px = (vx + 0.5) * VOXEL_SIZE;
    const py = (vy + 0.5) * VOXEL_SIZE;
    const pz = (vz + 0.5) * VOXEL_SIZE;
    for (const trunk of this.trunks) {
      if (py < trunk.y0 || py > trunk.y1) continue;
      const dx = px - trunk.x;
      const dz = pz - trunk.z;
      if (dx * dx + dz * dz <= trunk.radius * trunk.radius) return true;
    }
    return false;
  }
}

export class Snowball {
  /** Centre of the drawn ball. */
  x: number;
  y: number;
  z: number;
  /** Last substep's position, for drawing between substeps. */
  prevX: number;
  prevY: number;
  prevZ: number;
  vx: number;
  vy: number;
  vz: number;
  radius: number;
  /** Still rolling; false once it has come to rest for good. */
  rolling = true;
  /** Out of render distance of the player: frozen, and counting down to being forgotten. */
  far = false;
  /** Seconds spent far away without a break. */
  away = 0;

  /** Seconds left in which it counts as jammed against something; a jammed ball is not shoved further. */
  blocked = 0;
  /** The id the world gave it, for a rock that was part of the world rather than thrown; 0 otherwise. */
  worldId = 0;

  private rest = 0;
  private slopeX = 0;
  private slopeZ = 0;
  private age = 0;
  private snowTimer = 0;
  private snowy = false;
  private grounded = false;
  private supportTimer = 0;
  private readonly hit = createSphereCollision();

  constructor(
    readonly id: number,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    radius: number,
    readonly material: RollMaterial = SNOW,
  ) {
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.z = this.prevZ = z;
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.radius = radius;
  }

  /** Kilograms. */
  get mass(): number {
    return Math.max(0.05, this.material.density * (4 / 3) * Math.PI * this.radius ** 3);
  }

  /**
   * A blow: something of `mass` kilograms moving at (vx, vy, vz) hits it and
   * they share the momentum, as a swung stick or a walker does. A heavy thing
   * hardly notices a light one. Wakes it.
   */
  shove(vx: number, vy: number, vz: number, mass: number): void {
    const share = mass / (mass + this.mass);
    this.wake();
    this.vx += (vx - this.vx) * share;
    this.vy += (vy - this.vy) * share;
    this.vz += (vz - this.vz) * share;
  }

  /** How many snowballs it is worth: its size in units, rounded up. */
  get units(): number {
    return this.radius <= 0 ? 0 : Math.max(1, Math.ceil(this.radius / SNOW_WORTH_RADIUS - UNIT_SLACK));
  }

  /** Takes it out of the world (picked up): nothing is left of it, and a rope tied to it lets go. */
  vanish(): void {
    this.radius = 0;
    this.rolling = false;
  }

  /** Nothing left of it. */
  get spent(): boolean {
    return this.radius <= 0;
  }

  /**
   * One hit. Returns how many snowballs of snow came off, and shrinks the ball
   * in proportion, keeping it on the ground: a ball that was worth ten and
   * gave up two is worth eight, and looks it. A ball worth one is gone.
   */
  harvest(): number {
    const units = this.units;
    if (units === 0) return 0;
    const given = Math.min(units, Math.max(1, Math.ceil(units * HIT_FRACTION)));
    const left = units - given;
    const bottom = this.y - this.radius;
    this.radius = left <= 0 ? 0 : (this.radius * left) / units;
    this.y = bottom + this.radius;
    if (!this.rolling) this.prevY = this.y;
    return given;
  }

  step(dt: number, query: SolidQuery, snowAt: SnowAt): void {
    if (this.far) return;
    if (!this.rolling) {
      if (this.material.heavy) this.checkSupport(dt, query);
      return;
    }
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
    this.age += dt;
    this.blocked = Math.max(0, this.blocked - dt);

    if (this.material.grows) {
      this.snowTimer -= dt;
      if (this.snowTimer <= 0) {
        this.snowTimer = SNOW_CHECK_SECONDS;
        this.snowy = snowAt(this.x, this.z);
      }
    }

    const proxy = Math.min(this.radius, PROXY_MAX_RADIUS);
    const lift = this.radius - proxy;
    this.vy -= GRAVITY * dt;
    const landing = this.vy;
    const steepness = this.grounded ? this.pull(query, this.y - lift, proxy, dt) : 0;
    const r = sweepSphere(query, this.x, this.y - lift, this.z, proxy, this.vx, this.vy, this.vz, dt, this.hit);
    this.grounded = r.grounded;
    this.x = r.x;
    this.z = r.z;
    this.vy = r.vy;
    if (this.material.bounce > 0 && r.grounded && landing < -BOUNCE_MIN_SPEED) {
      this.vy = -landing * this.material.bounce;
      this.grounded = false;
    }
    // Pushing a sphere out of the corners of voxel treads can kick it sideways
    // from nothing; a contact only ever takes speed away.
    const slid = Math.hypot(r.vx, r.vz);
    const before = Math.hypot(this.vx, this.vz);
    // Stopped dead by something: shoving it on into that only squeezes it out
    // sideways, so whoever pushes it is held back instead (see yieldTo).
    if (before > BLOCKED_SPEED && slid < before * 0.5) this.blocked = BLOCKED_SECONDS;
    const tame = slid > before && slid > 0 ? before / slid : 1;
    this.vx = r.vx * tame;
    this.vz = r.vz * tame;

    let speed = Math.hypot(this.vx, this.vz);
    if (r.grounded && speed > 0) {
      const slowed =
        speed * (1 - Math.exp(-ROLL_DRAG_PROPORTIONAL * dt)) + (this.material.drag / (1 + this.radius)) * dt;
      const keep = Math.max(0, speed - slowed) / speed;
      this.vx *= keep;
      this.vz *= keep;
      speed *= keep;
      // Snow on the ground sticks to it: the harder it rolls, the more it takes.
      if (this.material.grows && this.snowy && speed > MIN_GROW_SPEED) {
        this.radius = Math.min(SNOWBALL_MAX_RADIUS, this.radius + GROW_PER_METRE * speed * dt);
      }
    }
    this.y = r.y + (this.radius - Math.min(this.radius, PROXY_MAX_RADIUS));

    this.rest = r.grounded && speed < REST_SPEED && steepness < this.material.restSlope ? this.rest + dt : 0;
    if (this.rest >= REST_SECONDS || this.age > MAX_ROLL_SECONDS) this.settle();
  }

  /** Gravity along the slope under the ball; returns how steep it is. */
  private pull(query: SolidQuery, centreY: number, proxy: number, dt: number): number {
    const reach = 0.3 + proxy * 0.5;
    const top = centreY;
    const east = groundTop(query, this.x + reach, this.z, top, 2);
    const west = groundTop(query, this.x - reach, this.z, top, 2);
    const south = groundTop(query, this.x, this.z + reach, top, 2);
    const north = groundTop(query, this.x, this.z - reach, top, 2);
    const blend = Math.min(1, dt * SLOPE_BLEND_PER_SECOND);
    if (east > -Infinity && west > -Infinity) this.slopeX += ((east - west) / (2 * reach) - this.slopeX) * blend;
    if (south > -Infinity && north > -Infinity) this.slopeZ += ((south - north) / (2 * reach) - this.slopeZ) * blend;
    const steepness = Math.hypot(this.slopeX, this.slopeZ);
    const scale = (GRAVITY * dt) / (1 + steepness * steepness);
    this.vx -= this.slopeX * scale;
    this.vz -= this.slopeZ * scale;
    return steepness;
  }

  /** A heavy ball lying still is woken if what it lay on has gone (dug away). */
  private checkSupport(dt: number, query: SolidQuery): void {
    this.supportTimer -= dt;
    if (this.supportTimer > 0) return;
    this.supportTimer = SUPPORT_CHECK_SECONDS;
    const below = query.isSolid(
      Math.floor(this.x / VOXEL_SIZE),
      Math.floor((this.y - this.radius - 0.05) / VOXEL_SIZE),
      Math.floor(this.z / VOXEL_SIZE),
    );
    if (!below) this.wake();
  }

  /** Set rolling again, as when it is shoved: it can grow once more, and has a fresh 60 seconds to settle. */
  wake(): void {
    this.rolling = true;
    this.rest = 0;
    this.age = 0;
    this.grounded = false;
  }

  /** Comes to rest where it is, to lie there until something wakes it. */
  settle(): void {
    this.rolling = false;
    this.vx = this.vy = this.vz = 0;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZ = this.z;
  }
}

export interface SnowballHit {
  ball: Snowball | undefined;
  distance: number;
}

export function createSnowballHit(): SnowballHit {
  return { ball: undefined, distance: 0 };
}

/** Every rolled snowball in the world, rolling or settled. */
export class SnowballField {
  readonly balls: Snowball[] = [];
  private nextId = 1;

  spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    radius = SNOW_UNIT_RADIUS,
    material: RollMaterial = SNOW,
  ): Snowball {
    const ball = new Snowball(this.nextId++, x, y, z, vx, vy, vz, radius, material);
    this.balls.push(ball);
    return ball;
  }

  /** One fixed substep of every ball that is still rolling. */
  step(dt: number, query: SolidQuery, snowAt: SnowAt): void {
    for (const ball of this.balls) ball.step(dt, query, snowAt);
    this.collide();
  }

  /**
   * Balls are solid to one another. A rolling ball runs into a settled one as
   * into a wall and into another rolling one as into a ball of its own weight
   * (mass goes with volume, so a big one barely notices a small one). Sorted
   * out along the ground only: it is the sweep against the terrain that
   * decides how high a ball sits.
   */
  private collide(): void {
    const balls = this.balls;
    for (let i = 0; i < balls.length; i++) {
      const a = balls[i];
      if (a === undefined || a.spent || a.far) continue;
      for (let j = i + 1; j < balls.length; j++) {
        const b = balls[j];
        if (b === undefined || b.spent || b.far) continue;
        if (!a.rolling && !b.rolling) continue;
        const reach = a.radius + b.radius;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dz = b.z - a.z;
        if (Math.abs(dx) >= reach || Math.abs(dz) >= reach || Math.abs(dy) >= reach) continue;
        const flat = Math.hypot(dx, dz);
        if (flat * flat + dy * dy >= reach * reach) continue;
        // Sideways gap the two need for their centres to be `reach` apart in 3D.
        const overlap = Math.sqrt(reach * reach - dy * dy) - flat;
        const nx = flat > 1e-6 ? dx / flat : 1;
        const nz = flat > 1e-6 ? dz / flat : 0;
        // A settled ball is a wall, unless it is heavy: a rock lying still can be knocked.
        const inverseA = a.rolling || a.material.heavy ? 1 / a.mass : 0;
        const inverseB = b.rolling || b.material.heavy ? 1 / b.mass : 0;
        const total = inverseA + inverseB;
        a.x -= nx * overlap * (inverseA / total);
        a.z -= nz * overlap * (inverseA / total);
        b.x += nx * overlap * (inverseB / total);
        b.z += nz * overlap * (inverseB / total);
        const closing = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
        if (closing >= 0) continue;
        const impulse = (-(1 + BALL_BOUNCE) * closing) / total;
        if (!a.rolling && a.material.heavy && impulse * inverseA < KNOCK_WAKE_SPEED) {
          // Too gentle a tap to wake a rock: it takes none of it.
        } else {
          if (!a.rolling && inverseA > 0) a.wake();
          a.vx -= impulse * inverseA * nx;
          a.vz -= impulse * inverseA * nz;
        }
        if (!b.rolling && b.material.heavy && impulse * inverseB < KNOCK_WAKE_SPEED) {
          // As above.
        } else {
          if (!b.rolling && inverseB > 0) b.wake();
          b.vx += impulse * inverseB * nx;
          b.vz += impulse * inverseB * nz;
        }
      }
    }
  }

  /**
   * Once a frame: freezes balls the player is out of range of, forgets the ones
   * that have been for long enough, and clears out any that are spent or lost.
   */
  tick(dt: number, playerX: number, playerZ: number, farDistance: number): void {
    for (let i = this.balls.length - 1; i >= 0; i--) {
      const ball = this.balls[i];
      if (ball === undefined) continue;
      ball.far = Math.hypot(ball.x - playerX, ball.z - playerZ) > farDistance;
      ball.away = ball.far ? ball.away + dt : 0;
      // Snow is forgotten when nobody is near; a rock stays where it is.
      const forgotten = !ball.material.heavy && ball.away >= SNOWBALL_DESPAWN_SECONDS;
      if (ball.spent || forgotten || ball.y < FALL_LIMIT_Y) {
        this.balls.splice(i, 1);
      }
    }
    this.trimThrown();
  }

  /** Thrown heavy balls are not forgotten, so the oldest far-off ones go when there are too many. */
  private trimThrown(): void {
    let heavy = 0;
    for (const ball of this.balls) if (ball.material.heavy) heavy++;
    for (let i = 0; heavy > MAX_HEAVY_BALLS && i < this.balls.length; ) {
      const ball = this.balls[i];
      if (ball !== undefined && ball.material.heavy && ball.far && !ball.rolling && ball.worldId === 0) {
        this.balls.splice(i, 1);
        heavy--;
      } else {
        i++;
      }
    }
  }

  /** The nearest ball a ray runs into within `maxDistance`, into `out`. */
  raycast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    maxDistance: number,
    out: SnowballHit,
  ): SnowballHit {
    out.ball = undefined;
    out.distance = maxDistance;
    for (const ball of this.balls) {
      if (ball.spent) continue;
      const cx = ball.x - ox;
      const cy = ball.y - oy;
      const cz = ball.z - oz;
      const along = cx * dx + cy * dy + cz * dz;
      if (along < -ball.radius) continue;
      const missSq = cx * cx + cy * cy + cz * cz - along * along;
      const radiusSq = ball.radius * ball.radius;
      if (missSq > radiusSq) continue;
      const distance = Math.max(0, along - Math.sqrt(radiusSq - missSq));
      if (distance < out.distance) {
        out.distance = distance;
        out.ball = ball;
      }
    }
    return out;
  }

  /**
   * Whoever is walking into a ball shoves it. Called before the balls step.
   * The ball is woken if it was lying still and takes the walker's speed along
   * the line between them, so it rolls ahead of them (and picks up snow if the
   * ground is snowy) for as long as they keep pushing, and on its own once they
   * stop. The walker is a vertical cylinder from `y` up `height`; a jump clears
   * a small ball. See {@link SnowballField.yieldTo} for the other half.
   */
  pushedBy(
    x: number,
    y: number,
    z: number,
    vx: number,
    vz: number,
    radius: number,
    height: number,
    walkerMass = Infinity,
  ): void {
    this.reaction.x = 0;
    this.reaction.z = 0;
    const finite = Number.isFinite(walkerMass);
    for (const ball of this.balls) {
      if (ball.blocked > 0 || !this.touching(ball, x, y, z, radius, height, contact)) continue;
      const closing = (vx - ball.vx) * contact.nx + (vz - ball.vz) * contact.nz;
      if (closing <= 0) continue;
      // Snow goes ahead at the walker's speed. Something heavy goes off with a share of it, and
      // pushes back on the walker for what it was given.
      const weighty = ball.material.heavy && finite;
      const share = weighty ? walkerMass / (walkerMass + ball.mass) : 1;
      const given = closing * PUSH_FACTOR * share;
      ball.vx += contact.nx * given;
      ball.vz += contact.nz * given;
      ball.wake();
      if (weighty) {
        this.reaction.x -= contact.nx * given * ball.mass;
        this.reaction.z -= contact.nz * given * ball.mass;
      }
    }
    const strength = Math.hypot(this.reaction.x, this.reaction.z);
    const most = finite ? walkerMass * MAX_REACTION_SPEED : 0;
    if (strength > most && strength > 0) {
      this.reaction.x *= most / strength;
      this.reaction.z *= most / strength;
    }
  }

  /**
   * What the last {@link pushedBy} pushed back on the walker with, N*s along
   * the ground: zero for snow, which weighs nothing worth speaking of. The
   * caller applies it to the walker.
   */
  readonly reaction = { x: 0, z: 0 };

  /**
   * Called after the balls have stepped: a ball that could not get out of the
   * walker's way (against a wall, a tree, a settled ball) is not walked
   * through. Writes how far the walker has to be moved back, along the ground,
   * into `out` as (x, z), zero if they are clear.
   */
  yieldTo(x: number, y: number, z: number, radius: number, height: number, out: { x: number; z: number }): void {
    out.x = 0;
    out.z = 0;
    for (const ball of this.balls) {
      if (!this.touching(ball, x + out.x, y, z + out.z, radius, height, contact)) continue;
      out.x -= contact.nx * contact.overlap;
      out.z -= contact.nz * contact.overlap;
    }
  }

  /** Is `ball` overlapping the walker; fills `into` with the line from walker to ball and how deep. */
  private touching(
    ball: Snowball,
    x: number,
    y: number,
    z: number,
    radius: number,
    height: number,
    into: Contact,
  ): boolean {
    if (ball.spent || ball.far) return false;
    const reach = ball.radius + radius;
    const dx = ball.x - x;
    const dz = ball.z - z;
    if (Math.abs(dx) >= reach || Math.abs(dz) >= reach) return false;
    // The nearest point of the walker's body to the ball's centre.
    const dy = ball.y - Math.min(Math.max(ball.y, y), y + height);
    const flat = Math.hypot(dx, dz);
    if (flat * flat + dy * dy >= reach * reach) return false;
    into.nx = flat > 1e-6 ? dx / flat : 1;
    into.nz = flat > 1e-6 ? dz / flat : 0;
    into.overlap = Math.sqrt(reach * reach - dy * dy) - flat;
    return true;
  }
}

interface Contact {
  nx: number;
  nz: number;
  overlap: number;
}
const contact: Contact = { nx: 0, nz: 0, overlap: 0 };

// --- thrown -------------------------------------------------------------

/** A put snowball is a little ball: about the size of the item. */
const FLYING_RADIUS = 0.1;
/** Less than the world's gravity: a shot-put throw goes out flatter than a lob. */
const FLYING_GRAVITY = 9;
const FLYING_MAX_SECONDS = 6;

export interface Flying {
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

/** Where a snowball burst, and which way the puff should go (back along where it came from). */
export interface Burst {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

export class ThrownSnowballs {
  readonly flying: Flying[] = [];
  /** Bursts since the caller last cleared this; it is theirs to empty. */
  readonly bursts: Burst[] = [];
  private readonly hit = createSphereCollision();

  throw(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    this.flying.push({ x, y, z, prevX: x, prevY: y, prevZ: z, vx, vy, vz, age: 0 });
  }

  step(dt: number, query: SolidQuery): void {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const ball = this.flying[i];
      if (ball === undefined) continue;
      ball.prevX = ball.x;
      ball.prevY = ball.y;
      ball.prevZ = ball.z;
      ball.age += dt;
      ball.vy -= FLYING_GRAVITY * dt;
      const r = sweepSphere(query, ball.x, ball.y, ball.z, FLYING_RADIUS, ball.vx, ball.vy, ball.vz, dt, this.hit);
      const blocked =
        Math.abs(r.vx - ball.vx) > 1e-6 || Math.abs(r.vy - ball.vy) > 1e-6 || Math.abs(r.vz - ball.vz) > 1e-6;
      if (blocked) {
        const speed = Math.max(1e-6, Math.hypot(ball.vx, ball.vy, ball.vz));
        this.bursts.push({
          x: r.x,
          y: r.y,
          z: r.z,
          nx: -ball.vx / speed,
          ny: -ball.vy / speed,
          nz: -ball.vz / speed,
        });
        this.removeAt(i);
        continue;
      }
      ball.x = r.x;
      ball.y = r.y;
      ball.z = r.z;
      if (ball.age > FLYING_MAX_SECONDS || ball.y < FALL_LIMIT_Y) this.removeAt(i);
    }
  }

  clear(): void {
    this.flying.length = 0;
    this.bursts.length = 0;
  }

  private removeAt(index: number): void {
    const last = this.flying.pop();
    if (last !== undefined && index < this.flying.length) this.flying[index] = last;
  }
}
