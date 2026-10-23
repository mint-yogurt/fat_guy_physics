/**
 * How the player turns the thing they are about to place. One of these lives
 * for as long as a placeable is held; every placeable is turned the same way,
 * so a ladder, a mat and a gift all answer to the same hands:
 *
 *  - the scroll wheel steps the spin by a fixed angle (45 degrees), snapping to
 *    that grid first: quick, tidy corners and right angles;
 *  - holding R and moving the mouse turns it freely, sideways to spin about
 *    whatever it is lying against and up and down to tilt it off the surface
 *    (lean a ladder, ramp a sheet). Free turning is a little sticky at the
 *    angles worth having, so level and square are easy to find by hand too.
 *
 * "Spin" is a turn about the surface's normal, "tilt" a lean of the long way
 * out of the surface. What those mean for a given item is the planner's
 * (buildPlan.ts); a mat or a gift only uses spin, as a turn about up.
 */

/** The wheel's step, radians: 45 degrees. */
export const SPIN_STEP = Math.PI / 4;
/** Free turning sticks to multiples of this, radians: 15 degrees... */
const MAGNET_STEP = Math.PI / 12;
/** ...from this close, radians: 3 degrees. */
const MAGNET_RANGE = (3 * Math.PI) / 180;
/** Radians of turn per pixel of mouse. */
const DRAG_PER_PIXEL = 0.01;
/** The furthest a piece may lean. */
const MAX_TILT = Math.PI / 2;

function stuck(angle: number): number {
  const nearest = Math.round(angle / MAGNET_STEP) * MAGNET_STEP;
  return Math.abs(angle - nearest) < MAGNET_RANGE ? nearest : angle;
}

function wrap(angle: number): number {
  const turn = Math.PI * 2;
  let a = angle % turn;
  if (a > Math.PI) a -= turn;
  else if (a <= -Math.PI) a += turn;
  return a;
}

export class PlacementOrientation {
  private rawSpin = 0;
  private rawTilt = 0;

  /** Turn about the surface normal, radians. */
  get spin(): number {
    return stuck(this.rawSpin);
  }

  /** Lean of the long way out of the surface, radians. */
  get tilt(): number {
    return stuck(this.rawTilt);
  }

  /** The wheel: `notches` steps of {@link SPIN_STEP} (positive turns one way, negative the other), from the nearest step. */
  step(notches: number): void {
    const whole = Math.round(this.rawSpin / SPIN_STEP);
    this.rawSpin = wrap((whole + Math.round(notches)) * SPIN_STEP);
  }

  /** R held and the mouse moved by (dx, dy) pixels: free turning. */
  drag(dx: number, dy: number): void {
    this.rawSpin = wrap(this.rawSpin + dx * DRAG_PER_PIXEL);
    this.rawTilt = Math.min(MAX_TILT, Math.max(-MAX_TILT, this.rawTilt + dy * DRAG_PER_PIXEL));
  }

  /** Back to square and level: a new item was picked up. */
  reset(): void {
    this.rawSpin = 0;
    this.rawTilt = 0;
  }
}
