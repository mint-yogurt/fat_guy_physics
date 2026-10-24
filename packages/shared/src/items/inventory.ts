/**
 * Hotbar plus backpack. Ports src/Inventory.{hpp,cpp}.
 *
 * Slot 0 is always Unarmed: it holds nothing, cannot be filled, and is what
 * scoop and chup require to be selected. Selecting another slot equips what
 * is in it: a stick is a weapon (swung with left mouse, thrown with right),
 * a log is carried and does nothing yet, a leaf is just held, and a skateboard
 * is stood on and ridden, and a snowball is rolled
 * along the ground or thrown.
 */

export const ItemType = {
  Stick: 0,
  Leaf: 1,
  Log: 2,
  /** Placed with left mouse, picked back up with E; see items/trampoline.ts. */
  Trampoline: 3,
  /** Ridden while it is the equipped item; see sim/skate.ts. */
  Skateboard: 4,
  /** Rolled with left mouse, put (shot-put style) with right; see items/snowball.ts. */
  Snowball: 5,
  /** Tied between two things with left mouse, gmod-tool-gun style; see items/rope.ts. */
  XmasLights: 6,
  /** Rolled with left mouse, put with right, like a snowball that does not grow; see items/rock.ts. */
  Rock: 7,
  /**
   * The three containers, as items: picked up empty with E, placed with left
   * mouse. Their rules live in items/container.ts.
   */
  PresentSmall: 8,
  PresentBig: 9,
  CandyBucket: 10,
  /**
   * Shaken with left mouse, thrown with right; bursts into green fizz when it
   * hits hard enough. Rules in items/vessel.ts.
   */
  MountainLightning: 11,
  /** Rolled with left mouse, put with right, exactly as a rock is; see items/rolledItems.ts. */
  Eggnog: 12,
  /** Held, and nothing else: clicks do nothing. A crafting ingredient to come. */
  Coal: 13,
  /** Slime. Used as the can is, but it does not carry far and it splats a stain; see items/vessel.ts. */
  Goo: 14,
  /** Held, and nothing else: clicks do nothing. A crafting ingredient to come. */
  Metal: 15,
  /** Held, and nothing else: clicks do nothing. */
  Candy: 16,
  /**
   * Crafting materials and products (items/crafting.ts). Held, and nothing else:
   * clicks do nothing. A 2x4 is a "toobifer".
   */
  Toobifer: 17,
  Plywood: 18,
  Wheel: 19,
  Ladder: 20,
  /** Crafting material (2 metal), and nothing else: clicks do nothing. */
  Spring: 21,
  /** Worn while selected: bounding steps and big jumps; see items/springShoes.ts. */
  SpringShoes: 22,
  /** Cast with left mouse (hold to throw farther), reeled in with right; see items/fishing.ts. */
  FishingRod: 23,
  /**
   * Made from leaves (items/crafting.ts). Rolled with left mouse, put with right, like a rock;
   * the paper it unrolls is drawn by the client (render/paperTrail.ts), the sim only rolls it.
   */
  ToiletPaper: 24,
  /**
   * Worn while selected, and nothing else: no clicks. Falling with it open is slow and
   * drifts forward; see items/parachute.ts. Meant to become gear (items/gear.ts).
   */
  Parachute: 25,
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export const ITEM_TYPE_COUNT = 26;

export const ITEM_NAMES = [
  "stick",
  "leaf",
  "log",
  "trampoline",
  "skateboard",
  "snowball",
  "xmas_lights",
  "rock",
  "present",
  "gift",
  "candy_bucket",
  "mountain_lightning",
  "eggnog",
  "coal",
  "goo",
  "metal",
  "candy",
  "toobifer",
  "plywood",
  "wheel",
  "ladder",
  "spring",
  "spring_shoes",
  "fishing_rod",
  "toilet_paper",
  "parachute",
] as const;

/**
 * What the player sees an item called, where it differs from its name here
 * (the names are ids: the generation sheet and the saved data use them).
 */
const DISPLAY_NAMES: Readonly<Record<string, string>> = {
  mountain_lightning: "mowden lightning",
};

export function itemDisplayName(type: ItemType): string {
  const name = ITEM_NAMES[type] ?? "item";
  return DISPLAY_NAMES[name] ?? name.replaceAll("_", " ");
}

/** Most of one item a single slot holds. */
export const MAX_STACK = 255;

/**
 * The item a generation-sheet name refers to, if there is one yet. The sheet
 * is allowed to name items that do not exist (zinc) so a row can be
 * written ahead of the item; those resolve to nothing and are skipped.
 */
export function itemTypeFromName(name: string): ItemType | undefined {
  const index = (ITEM_NAMES as readonly string[]).indexOf(name);
  return index < 0 ? undefined : (index as ItemType);
}

/**
 * The inventory is a grid, `INVENTORY_COLUMNS` wide, with the hotbar as its
 * bottom row and the backpack (the slots after the hotbar) above it. Adding
 * rows is a one-number change here; the screen lays itself out from these.
 */
export const INVENTORY_COLUMNS = 8;
export const INVENTORY_ROWS = 4;
export const HOTBAR_SLOTS = INVENTORY_COLUMNS;
export const BACKPACK_SLOTS = INVENTORY_COLUMNS * (INVENTORY_ROWS - 1);
export const TOTAL_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

export interface ItemStack {
  type: ItemType;
  count: number;
}

/**
 * Anything that is a grid of slots the player can move stacks between: the
 * inventory, a container, the crafting inputs. The item cursor (itemCursor.ts)
 * works on this and nothing more specific.
 */
export interface ItemGrid {
  readonly size: number;
  slot(index: number): ItemStack | undefined;
  /** Replaces what is in a slot outright; the caller has checked {@link accepts}. */
  setSlot(index: number, stack: ItemStack | undefined): void;
  /** Whether this slot may hold `type` at all (the Unarmed slot holds nothing). */
  accepts(index: number, type: ItemType): boolean;
}

export class Inventory implements ItemGrid {
  /** Index 0 is Unarmed and stays undefined by invariant. */
  private readonly slots: (ItemStack | undefined)[] = new Array<ItemStack | undefined>(
    TOTAL_SLOTS,
  ).fill(undefined);

  private selected = 0;

  /** Bumped on every change, so the UI can skip rebuilding an unchanged hotbar. */
  version = 0;

  get selectedSlot(): number {
    return this.selected;
  }

  /**
   * Bare hands: slot 0, or any slot with nothing in it. An empty hotbar slot
   * does what Unarmed does (scoop, chup); only the icon stays on slot 0.
   */
  get isUnarmedSelected(): boolean {
    return this.selected === 0 || this.slots[this.selected] === undefined;
  }

  selectSlot(index: number): void {
    if (index < 0 || index >= HOTBAR_SLOTS || index === this.selected) return;
    this.selected = index;
    this.version++;
  }

  get size(): number {
    return TOTAL_SLOTS;
  }

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  accepts(index: number, _type: ItemType): boolean {
    return index > 0 && index < TOTAL_SLOTS;
  }

  setSlot(index: number, stack: ItemStack | undefined): void {
    if (index <= 0 || index >= TOTAL_SLOTS) return;
    this.slots[index] = stack === undefined || stack.count <= 0 ? undefined : stack;
    this.version++;
  }

  /** How many more of `type` {@link tryAdd} would take. */
  roomFor(type: ItemType): number {
    let room = 0;
    for (let i = 1; i < TOTAL_SLOTS; i++) {
      const stack = this.slots[i];
      if (stack === undefined) room += MAX_STACK;
      else if (stack.type === type) room += MAX_STACK - stack.count;
    }
    return room;
  }

  /**
   * Tops up stacks of the same type first (each holds {@link MAX_STACK}), then
   * fills empty slots after 0. All or nothing: false, and nothing added, if it
   * will not all fit.
   */
  tryAdd(type: ItemType, count = 1): boolean {
    if (this.roomFor(type) < count) return false;

    let left = count;
    for (let i = 1; i < TOTAL_SLOTS && left > 0; i++) {
      const stack = this.slots[i];
      if (stack === undefined || stack.type !== type) continue;
      const moved = Math.min(left, MAX_STACK - stack.count);
      stack.count += moved;
      left -= moved;
    }
    for (let i = 1; i < TOTAL_SLOTS && left > 0; i++) {
      if (this.slots[i] !== undefined) continue;
      const moved = Math.min(left, MAX_STACK);
      this.slots[i] = { type, count: moved };
      left -= moved;
    }
    this.version++;
    return true;
  }

  selectedItem(): ItemStack | undefined {
    return this.slots[this.selected];
  }

  tryConsumeSelected(count = 1): boolean {
    const stack = this.slots[this.selected];
    if (stack === undefined || stack.count < count) return false;
    stack.count -= count;
    if (stack.count === 0) this.slots[this.selected] = undefined;
    this.version++;
    return true;
  }
}
