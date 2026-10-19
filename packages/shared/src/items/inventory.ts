/**
 * Hotbar plus backpack. Ports src/Inventory.{hpp,cpp}.
 *
 * Slot 0 is always Unarmed: it holds nothing, cannot be filled, and is what
 * scoop and chup require to be selected. That is the whole tool system for
 * now -- selecting an item slot simply means your hands are full.
 */

export const ItemType = {
  Stick: 0,
  Leaf: 1,
  Log: 2,
} as const;
export type ItemType = (typeof ItemType)[keyof typeof ItemType];

export const ITEM_TYPE_COUNT = 3;

export const ITEM_NAMES = ["stick", "leaf", "log"] as const;

export const HOTBAR_SLOTS = 8;
export const BACKPACK_SLOTS = 16;
export const TOTAL_SLOTS = HOTBAR_SLOTS + BACKPACK_SLOTS;

export interface ItemStack {
  type: ItemType;
  count: number;
}

export class Inventory {
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

  get isUnarmedSelected(): boolean {
    return this.selected === 0;
  }

  selectSlot(index: number): void {
    if (index < 0 || index >= HOTBAR_SLOTS || index === this.selected) return;
    this.selected = index;
    this.version++;
  }

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  /** Stacks onto the same type first, then the first empty slot after 0. */
  tryAdd(type: ItemType, count = 1): boolean {
    for (let i = 1; i < TOTAL_SLOTS; i++) {
      const stack = this.slots[i];
      if (stack !== undefined && stack.type === type) {
        stack.count += count;
        this.version++;
        return true;
      }
    }
    for (let i = 1; i < TOTAL_SLOTS; i++) {
      if (this.slots[i] === undefined) {
        this.slots[i] = { type, count };
        this.version++;
        return true;
      }
    }
    return false;
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
