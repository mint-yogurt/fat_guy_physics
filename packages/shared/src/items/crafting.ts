import { type ItemGrid, type ItemStack, type ItemType } from "./inventory.ts";

/**
 * The crafting inputs: `_ + _ = _`, growing a box whenever the last one is
 * filled, so a recipe can take as many different items as it needs.
 *
 * STUB: only the boxes and their rules exist. There are no recipes yet, so the
 * result box is always empty. When recipes arrive they go in {@link RECIPES};
 * matching them against the inputs belongs in {@link CraftingBench.result}.
 */

/** Boxes shown with nothing in them: the `_ + _`. */
export const CRAFT_MIN_BOXES = 2;
/** The most items one recipe can take, for now. */
export const CRAFT_MAX_BOXES = 6;

export interface Recipe {
  readonly inputs: readonly { readonly type: ItemType; readonly count: number }[];
  readonly output: ItemStack;
}

/** No recipes yet. */
export const RECIPES: readonly Recipe[] = [];

export class CraftingBench implements ItemGrid {
  readonly size = CRAFT_MAX_BOXES;
  version = 0;

  private readonly slots: (ItemStack | undefined)[] = new Array<ItemStack | undefined>(CRAFT_MAX_BOXES).fill(
    undefined,
  );

  /**
   * How many input boxes to show: two, and one more past the last one holding
   * something. Never hides an item, whatever order the boxes were filled in.
   */
  get visibleBoxes(): number {
    let last = -1;
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) if (this.slots[i] !== undefined) last = i;
    return Math.min(CRAFT_MAX_BOXES, Math.max(CRAFT_MIN_BOXES, last + 2));
  }

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  accepts(index: number, _type: ItemType): boolean {
    return index >= 0 && index < CRAFT_MAX_BOXES;
  }

  setSlot(index: number, stack: ItemStack | undefined): void {
    if (index < 0 || index >= CRAFT_MAX_BOXES) return;
    this.slots[index] = stack === undefined || stack.count <= 0 ? undefined : stack;
    this.version++;
  }

  /** What the inputs make. STUB: always nothing; see the file comment. */
  result(): ItemStack | undefined {
    return undefined;
  }

  /** Empties the boxes, returning what was in them (the screen puts it back in the inventory). */
  takeAll(): ItemStack[] {
    const out: ItemStack[] = [];
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) {
      const stack = this.slots[i];
      if (stack === undefined) continue;
      out.push(stack);
      this.slots[i] = undefined;
    }
    if (out.length > 0) this.version++;
    return out;
  }
}
