import { HOTBAR_SLOTS, ITEM_NAMES, type Inventory } from "@fgp/shared/items/inventory";

/**
 * The always-visible hotbar.
 *
 * DOM rather than drawn into the canvas: it is a handful of boxes with text
 * in them, and the browser is better at that than a vertex buffer is. Only
 * redraws when the inventory's version changes, so the per-frame cost on a
 * normal frame is one integer comparison.
 */
export class Hotbar {
  private readonly slots: HTMLDivElement[] = [];
  private lastVersion = -1;

  constructor(private readonly root: HTMLElement) {
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const key = document.createElement("span");
      key.className = "slot-key";
      key.textContent = String(i + 1);
      const label = document.createElement("span");
      label.className = "slot-label";
      slot.append(key, label);
      this.root.append(slot);
      this.slots.push(slot);
    }
  }

  sync(inventory: Inventory): void {
    if (inventory.version === this.lastVersion) return;
    this.lastVersion = inventory.version;

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      if (slot === undefined) continue;
      slot.classList.toggle("selected", i === inventory.selectedSlot);

      const label = slot.querySelector(".slot-label");
      if (label === null) continue;
      if (i === 0) {
        // Slot 0 is the bare hands, and the only slot that does anything
        // yet -- scoop and chup both require it.
        label.textContent = "fist";
        continue;
      }
      const stack = inventory.slot(i);
      label.textContent = stack === undefined ? "" : `${ITEM_NAMES[stack.type]} ${stack.count}`;
    }
  }
}
