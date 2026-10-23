import { ITEM_TYPE_COUNT, ItemType } from "./inventory.ts";

/**
 * What a player's hands are doing, as far as anyone watching can tell: the
 * item in them and the action under way. This is all a renderer needs to
 * draw a player's hands, in first person or as somebody else's character in
 * third person. It is small and plain on purpose, because in multiplayer it
 * is the part of a player that goes over the wire every tick: the local
 * player builds one from input, a remote player's arrives in a packet, and
 * both go to the same renderers (`packAvatarPose`/`unpackAvatarPose`).
 *
 * Looping actions (scoop, chup) are just "on" while the button is held; each
 * viewer runs its own swing cycle at the shared period below, so nothing
 * per-frame has to be sent. One-shot actions (a throw) are a counter that
 * goes up by one each time, so a viewer that missed a packet still sees it
 * change and plays the follow-through once; `thrown` says which kind of
 * throw it was, since a tap can be shorter than a tick and the charge that
 * led up to it never sent.
 *
 * How an action looks depends on how the item is held, not on the item
 * itself: a chup with an empty hand is a karate chop, with a blade-held item
 * it is a sword slash. Adding an item means giving it a hold style here and
 * a mesh in the client's held-item rigs (render/heldItems.ts); a new kind of
 * action means a new `AvatarAction` and a pose for it in both views.
 */

export const AvatarAction = {
  Idle: 0,
  /** Left mouse, unarmed: scooping dirt or leaves with both hands. */
  Scoop: 1,
  /** A chup: right mouse unarmed, or left mouse swinging a blade-held item. */
  Chup: 2,
  /** Right mouse held with a blade-held item: drawing back for a spear throw. */
  Charge: 3,
  /** Left mouse held with a carried item: swinging back to bowl it along the ground. */
  Bowl: 4,
  /** Right mouse held with a carried item: down between the knees for an underhand lob. */
  Lob: 5,
  /** Right mouse held with a ball in hand: cocked at the shoulder for an overhand shot-put throw. */
  Put: 6,
  /** Left mouse held with a can or a ball of goo: shaking it up before it is thrown. */
  Shake: 7,
} as const;
export type AvatarAction = (typeof AvatarAction)[keyof typeof AvatarAction];

const LAST_ACTION = AvatarAction.Shake;

/** True for the actions that wind up a throw. */
export function isThrowCharge(action: AvatarAction): boolean {
  return (
    action === AvatarAction.Charge ||
    action === AvatarAction.Bowl ||
    action === AvatarAction.Lob ||
    action === AvatarAction.Put
  );
}

/**
 * How an item sits in the hand, which decides the grip and what each action
 * looks like while holding it.
 */
export const HoldStyle = {
  /** Nothing in hand. */
  Empty: 0,
  /** Gripped at one end like a sword, business end out: a stick. */
  Blade: 1,
  /** Cradled in front with both arms: a log. Bowled or lobbed, not swung. */
  Carry: 2,
  /** Pinched in the fingers: a leaf. */
  Pinch: 3,
  /** Held in a fist at the shoulder: a snowball. Rolled on left mouse, put on right. */
  Ball: 4,
} as const;
export type HoldStyle = (typeof HoldStyle)[keyof typeof HoldStyle];

const HOLD_STYLES: Record<ItemType, HoldStyle> = {
  [ItemType.Stick]: HoldStyle.Blade,
  [ItemType.Leaf]: HoldStyle.Pinch,
  [ItemType.Log]: HoldStyle.Carry,
  // Held out in both arms, but only to be placed: main never bowls or lobs it.
  [ItemType.Trampoline]: HoldStyle.Carry,
  // Not in a hand at all: it is under the feet.
  [ItemType.Skateboard]: HoldStyle.Empty,
  [ItemType.Snowball]: HoldStyle.Ball,
  // A coil in the fist; tying it off is a click, with no wind-up to show.
  [ItemType.XmasLights]: HoldStyle.Ball,
  // In the fist, rolled and put exactly as a snowball is.
  [ItemType.Rock]: HoldStyle.Ball,
  // Held out in both arms, but only to be placed, like the trampoline.
  [ItemType.PresentSmall]: HoldStyle.Carry,
  [ItemType.PresentBig]: HoldStyle.Carry,
  [ItemType.CandyBucket]: HoldStyle.Carry,
  // In the fist: shaken on left mouse, put on right.
  [ItemType.MountainLightning]: HoldStyle.Ball,
  // In the fist, rolled and put exactly as a rock is.
  [ItemType.Eggnog]: HoldStyle.Ball,
  // In the fist, and that is all.
  [ItemType.Coal]: HoldStyle.Ball,
  [ItemType.Goo]: HoldStyle.Ball,
  [ItemType.Metal]: HoldStyle.Ball,
  [ItemType.Candy]: HoldStyle.Ball,
  // Cradled in both arms, like a log; they do nothing yet.
  [ItemType.Toobifer]: HoldStyle.Carry,
  [ItemType.Plywood]: HoldStyle.Carry,
  [ItemType.Wheel]: HoldStyle.Carry,
  [ItemType.Ladder]: HoldStyle.Carry,
  // In the fist, and that is all.
  [ItemType.Spring]: HoldStyle.Ball,
  // Not in a hand at all: they are on the feet.
  [ItemType.SpringShoes]: HoldStyle.Empty,
  // Gripped at the handle like a stick, tip out. Casting reuses the spear wind-up and lunge, but
  // the rod never leaves the hand (`leavesHandOnThrow`).
  [ItemType.FishingRod]: HoldStyle.Blade,
  // In the fist, rolled and put exactly as a rock is.
  [ItemType.ToiletPaper]: HoldStyle.Ball,
};

/** Whether a throw of the held item sends it out of the hand (a stick, a log); a cast keeps the rod. */
export function leavesHandOnThrow(held: ItemType | undefined): boolean {
  return held !== ItemType.FishingRod;
}

export function holdStyleOf(held: ItemType | undefined): HoldStyle {
  return held === undefined ? HoldStyle.Empty : HOLD_STYLES[held];
}

/** Seconds per swing cycle of each looping action, shared by every viewer. */
export const CHUP_CYCLE_SECONDS = 0.5;
export const SCOOP_CYCLE_SECONDS = 0.35;
/** Seconds per shake of a can or a ball of goo, up and down once. */
export const SHAKE_CYCLE_SECONDS = 0.16;
/** Seconds the follow-through after a throw lasts. */
export const THROW_FOLLOW_SECONDS = 0.28;

export interface AvatarPose {
  held: ItemType | undefined;
  action: AvatarAction;
  /** Throw charge, 0..1; only meaningful while winding up a throw. */
  charge: number;
  /** Counts throws, wrapping at 256. A change means "a throw just happened". */
  throwSeq: number;
  /** The wind-up the latest throw came out of (Charge, Bowl, Lob or Put). */
  thrown: AvatarAction;
}

export function createAvatarPose(): AvatarPose {
  return {
    held: undefined,
    action: AvatarAction.Idle,
    charge: 0,
    throwSeq: 0,
    thrown: AvatarAction.Charge,
  };
}

const NO_ITEM = 0xff;

/**
 * Four bytes, as one unsigned 32-bit number: held item (0xff for none),
 * action (low nibble) and last throw's kind (high nibble), charge quantised
 * to 1/255, throw counter.
 */
export function packAvatarPose(pose: AvatarPose): number {
  const held = pose.held ?? NO_ITEM;
  const actions = (pose.action & 0x0f) | ((pose.thrown & 0x0f) << 4);
  const charge = Math.round(Math.min(1, Math.max(0, pose.charge)) * 255);
  return ((held & 0xff) | (actions << 8) | (charge << 16) | ((pose.throwSeq & 0xff) << 24)) >>> 0;
}

const toAction = (value: number): AvatarAction =>
  value <= LAST_ACTION ? (value as AvatarAction) : AvatarAction.Idle;

export function unpackAvatarPose(packed: number, out: AvatarPose = createAvatarPose()): AvatarPose {
  const held = packed & 0xff;
  out.held = held < ITEM_TYPE_COUNT ? (held as ItemType) : undefined;
  out.action = toAction((packed >>> 8) & 0x0f);
  out.thrown = toAction((packed >>> 12) & 0x0f);
  out.charge = ((packed >>> 16) & 0xff) / 255;
  out.throwSeq = (packed >>> 24) & 0xff;
  return out;
}

/**
 * Turns the counter into "did a throw just happen", per viewer. Each
 * renderer keeps one of these for each player it draws.
 */
export class ThrowWatcher {
  private last: number | undefined;

  /** True once for each new value of `throwSeq`; never on the first look. */
  check(throwSeq: number): boolean {
    const fired = this.last !== undefined && this.last !== throwSeq;
    this.last = throwSeq;
    return fired;
  }
}
