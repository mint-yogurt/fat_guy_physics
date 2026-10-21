import { HOTBAR_SLOTS, type Inventory } from "@fgp/shared/items/inventory";
import type { WebGPURenderer } from "three/webgpu";

import type { HeldItemSources } from "../render/heldItems.ts";
import { HotbarItems, type HotbarSlotView } from "../render/hotbarItems.ts";

/**
 * The always-visible hotbar.
 *
 * The DOM holds each slot's border, its number, and the bare-hands icon of
 * slot 0. The items themselves are meshes drawn into the canvas by
 * HotbarItems, which also draws the slot backdrops, since the canvas sits
 * beneath the DOM. Which slots hold what only changes with the inventory's
 * version, so the DOM is touched only then; the meshes turn every frame.
 */
export class Hotbar {
  private readonly slots: HTMLDivElement[] = [];
  private readonly counts: HTMLSpanElement[] = [];
  private readonly items: HotbarItems;
  private readonly views: HotbarSlotView[] = [];
  private lastVersion = -1;
  private rectsStale = true;
  private visible = true;

  constructor(
    private readonly root: HTMLElement,
    sources: HeldItemSources,
  ) {
    this.items = new HotbarItems(HOTBAR_SLOTS, sources);
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const key = document.createElement("span");
      key.className = "slot-key";
      key.textContent = String(i + 1);
      slot.append(key);
      if (i === 0) {
        // Slot 0 is the bare hands, and the only slot that does anything
        // yet -- scoop and chup both require it.
        const icon = document.createElement("img");
        icon.className = "slot-icon";
        icon.src = "/icons/unarmed.png";
        icon.alt = "";
        icon.draggable = false;
        slot.append(icon);
      }
      const count = document.createElement("span");
      count.className = "slot-count";
      slot.append(count);
      this.root.append(slot);
      this.slots.push(slot);
      this.counts.push(count);
    }
    window.addEventListener("resize", this.markStale);
  }

  /** Hidden while the inventory screen is up, which has the hotbar as its bottom row. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    this.root.style.visibility = visible ? "" : "hidden";
    if (visible) this.rectsStale = true;
  }

  private readonly markStale = (): void => {
    this.rectsStale = true;
  };

  sync(inventory: Inventory): void {
    if (inventory.version === this.lastVersion) return;
    this.lastVersion = inventory.version;
    this.rectsStale = true;

    for (let i = 0; i < this.slots.length; i++) {
      const stack = i === 0 ? undefined : inventory.slot(i);
      const count = this.counts[i];
      if (count !== undefined) {
        count.textContent = stack !== undefined && stack.count > 1 ? String(stack.count) : "";
      }
      const rect = this.views[i];
      this.views[i] = {
        x: rect?.x ?? 0,
        y: rect?.y ?? 0,
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
        item: stack?.type,
        selected: i === inventory.selectedSlot,
      };
      this.slots[i]?.classList.toggle("selected", i === inventory.selectedSlot);
    }
  }

  /** Draws the items over the finished frame; call after the main pass. */
  render(renderer: WebGPURenderer, now: number): void {
    if (!this.visible) return;
    if (this.rectsStale) {
      this.rectsStale = false;
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const view = this.views[i];
        if (slot === undefined || view === undefined) continue;
        const rect = slot.getBoundingClientRect();
        this.views[i] = { ...view, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    this.items.render(renderer, this.views, now);
  }

  dispose(): void {
    window.removeEventListener("resize", this.markStale);
    this.items.dispose();
  }
}
