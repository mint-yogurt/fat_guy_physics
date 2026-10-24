import type { ItemType } from "./inventory.ts";

/**
 * Gear: items that are worn rather than held, like armour in Minecraft. There is no gear bar yet,
 * so every gear item is still an ordinary hotbar item that is "worn" while it is the selected one.
 * This file is the seam for that day, so the item rules never ask "is it selected?" themselves:
 * they ask {@link isWorn}.
 *
 * To move an item onto the gear bar once it exists:
 *  1. give it a slot in {@link GEAR_SLOT_OF};
 *  2. pass the gear bar's contents as `gear` in the one place main.ts calls {@link isWorn}
 *     (grep `isWorn`), and refuse to put the item on the hotbar.
 * Nothing in items/parachute.ts or the renderers changes.
 */

export const GearSlot = {
  /** Carried on the back: a parachute, a hang glider. */
  Back: 0,
} as const;
export type GearSlot = (typeof GearSlot)[keyof typeof GearSlot];

/**
 * Which gear slot an item belongs in. EMPTY on purpose, for now: an item listed here is worn from
 * the gear bar and no longer from the hotbar. The parachute is meant to be
 * `[ItemType.Parachute]: GearSlot.Back`.
 */
export const GEAR_SLOT_OF: Readonly<Partial<Record<ItemType, GearSlot>>> = {};

/** The slot `type` is worn in, or undefined while it is an ordinary hotbar item. */
export function gearSlotOf(type: ItemType): GearSlot | undefined {
  return GEAR_SLOT_OF[type];
}

/**
 * Whether `type` is on the player: the selected hotbar item, unless it is gear, in which case it
 * is whatever sits in its slot of `gear` (indexed by {@link GearSlot}; no gear bar yet, so empty).
 */
export function isWorn(
  type: ItemType,
  selected: ItemType | undefined,
  gear: readonly (ItemType | undefined)[] = [],
): boolean {
  const slot = gearSlotOf(type);
  return slot === undefined ? selected === type : gear[slot] === type;
}
