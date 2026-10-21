/**
 * Small pure trackers that turn continuous game state into one-off sound
 * events. No DOM and no audio here, so they are easy to test.
 */

/** Metres walked per footfall. */
export const STRIDE_METERS = 1.3;

/** Counts distance walked and says when a foot comes down. */
export class StrideTracker {
  private walked = 0;
  /** Alternates each footfall, for a left/right pitch difference. */
  foot = 0;

  constructor(private readonly stride = STRIDE_METERS) {}

  /** `speed` in m/s while walking on the ground; pass 0 in the air, riding, or standing. */
  update(dt: number, speed: number): boolean {
    if (speed <= 0.2) {
      // Standing still: the next step starts a fresh stride, on a foot.
      this.walked = this.stride * 0.5;
      return false;
    }
    this.walked += speed * dt;
    if (this.walked < this.stride) return false;
    this.walked -= this.stride;
    this.foot ^= 1;
    return true;
  }
}

/** Slower than this and a landing makes no sound (m/s). A jump lands at about 6. */
export const LAND_MIN_SPEED = 9;
/** Landings at or past this are full volume (m/s). */
export const LAND_FULL_SPEED = 24;

/** Volume 0..1 for coming down at `speed` m/s; 0 if too gentle to hear. */
export function landingGain(speed: number): number {
  if (speed < LAND_MIN_SPEED) return 0;
  return 0.35 + 0.65 * Math.min(1, (speed - LAND_MIN_SPEED) / (LAND_FULL_SPEED - LAND_MIN_SPEED));
}

/**
 * Fires once when a value rises past `high`, and not again until it has
 * dropped back below `low`. Keyed, so many things (ropes) can each have one.
 */
export class RisingEdge<K extends object> {
  private readonly armed = new WeakSet<K>();

  constructor(
    private readonly high: number,
    private readonly low: number,
  ) {}

  update(key: K, value: number): boolean {
    if (this.armed.has(key)) {
      if (value < this.low) this.armed.delete(key);
      return false;
    }
    if (value < this.high) return false;
    this.armed.add(key);
    return true;
  }
}

/**
 * A sound heard now and then in the distance. It only counts down while
 * `intensity` (0..1, how much of the right place you are in) is past
 * `threshold`, so nothing is owed for time spent elsewhere.
 */
export class AmbienceScheduler {
  private wait: number;

  constructor(
    private readonly minSeconds: number,
    private readonly maxSeconds: number,
    private readonly threshold: number,
    private readonly random: () => number = Math.random,
  ) {
    this.wait = this.draw();
  }

  update(dt: number, intensity: number): boolean {
    if (intensity < this.threshold) return false;
    this.wait -= dt;
    if (this.wait > 0) return false;
    this.wait = this.draw();
    return true;
  }

  private draw(): number {
    return this.minSeconds + (this.maxSeconds - this.minSeconds) * this.random();
  }
}
