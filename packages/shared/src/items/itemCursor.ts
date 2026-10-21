import { MAX_STACK, type ItemGrid, type ItemStack } from "./inventory.ts";

/**
 * The stack on the mouse while the inventory screen is open.
 *
 * Minecraft's rules, minus the bits this game does not have yet (split, drag,
 * shift-click): a click on a slot picks its whole stack up; a click on a slot
 * while holding puts it down, swaps with what is there, or tops up a stack of
 * the same item; right click cancels the move and puts the stack back where
 * it came from.
 *
 * Works on any {@link ItemGrid}, so moving between the inventory, a container
 * and the crafting inputs is the same click.
 */
export class ItemCursor {
  held: ItemStack | undefined;
  /** Bumped on every change, so the screen can skip redrawing an unchanged cursor. */
  version = 0;

  private fromGrid: ItemGrid | undefined;
  private fromIndex = 0;

  get empty(): boolean {
    return this.held === undefined;
  }

  /** A left click on a slot. True if anything moved. */
  click(grid: ItemGrid, index: number): boolean {
    if (index < 0 || index >= grid.size) return false;
    const there = grid.slot(index);

    if (this.held === undefined) {
      if (there === undefined) return false;
      grid.setSlot(index, undefined);
      this.held = there;
      this.fromGrid = grid;
      this.fromIndex = index;
      this.version++;
      return true;
    }

    if (!grid.accepts(index, this.held.type)) return false;

    if (there === undefined) {
      grid.setSlot(index, this.held);
      this.held = undefined;
    } else if (there.type === this.held.type) {
      const moved = Math.min(MAX_STACK - there.count, this.held.count);
      if (moved <= 0) return false;
      grid.setSlot(index, { type: there.type, count: there.count + moved });
      this.held = moved === this.held.count ? undefined : { type: this.held.type, count: this.held.count - moved };
    } else {
      grid.setSlot(index, this.held);
      this.held = there;
    }
    this.version++;
    return true;
  }

  /**
   * Right click: puts the stack back where it was picked up. If that slot has
   * since been filled with something else it goes into the first slot of that
   * grid that will take it. Returns whatever still did not fit, for the caller
   * to drop on the ground; undefined when all of it found a home.
   */
  cancel(): ItemStack | undefined {
    const held = this.held;
    const grid = this.fromGrid;
    if (held === undefined) return undefined;
    this.held = undefined;
    this.fromGrid = undefined;
    this.version++;
    if (grid === undefined) return held;

    let left = held.count;
    const tryInto = (index: number): void => {
      if (left <= 0 || !grid.accepts(index, held.type)) return;
      const there = grid.slot(index);
      if (there === undefined) {
        const put = Math.min(left, MAX_STACK);
        grid.setSlot(index, { type: held.type, count: put });
        left -= put;
      } else if (there.type === held.type && there.count < MAX_STACK) {
        const put = Math.min(left, MAX_STACK - there.count);
        grid.setSlot(index, { type: there.type, count: there.count + put });
        left -= put;
      }
    };
    tryInto(this.fromIndex);
    for (let i = 0; i < grid.size; i++) tryInto(i);
    return left > 0 ? { type: held.type, count: left } : undefined;
  }
}
