import {
  INVENTORY_COLUMNS,
  INVENTORY_ROWS,
  HOTBAR_SLOTS,
  TOTAL_SLOTS,
  itemDisplayName,
  type Inventory,
  type ItemGrid,
  type ItemStack,
} from "@fgp/shared/items/inventory";
import {
  CONTAINER_NAMES,
  MAX_CONTAINER_SLOTS,
  containerKindOfItem,
  takeAll,
  type ContainerKind,
  type ContainerStorage,
} from "@fgp/shared/items/container";
import { CRAFT_MAX_BOXES, type CraftingBench } from "@fgp/shared/items/crafting";
import type { ItemCursor } from "@fgp/shared/items/itemCursor";
import type { WebGPURenderer } from "three/webgpu";

import type { HeldItemSources } from "../render/heldItems.ts";
import { HotbarItems, type HotbarSlotView } from "../render/hotbarItems.ts";

/**
 * The inventory screen: crafting on top (a third of the panel), the inventory
 * grid below it (two thirds), and, when a container is in reach, its grid
 * beside them.
 *
 * Same trick as the hotbar (ui/hotbar.ts): the DOM holds borders, numbers and
 * hit-testing, and everything translucent -- the dimming, the panels, the
 * slot backdrops -- plus the item meshes are drawn into the canvas by a
 * {@link HotbarItems} pass, because the canvas sits beneath the DOM and a
 * translucent CSS fill would dim the items.
 *
 * The clicking rules are the item cursor's (shared/items/itemCursor.ts); this
 * file only turns mouse events into `cursor.click(grid, index)`.
 */

/** What the screen needs from the game that it cannot do itself. */
export interface InventoryScreenHooks {
  /** Something happened worth a sound. */
  sound(name: "pick" | "place" | "cancel" | "error"): void;
  /** A stack that found no room (closing with a full inventory) goes on the ground. */
  drop(stack: ItemStack): void;
}

export interface OpenContainer {
  readonly kind: ContainerKind;
  readonly storage: ContainerStorage;
}

const DIM_OPACITY = 0.55;
const PANEL_OPACITY = 0.5;
const DIM_DEPTH = -420;
const PANEL_DEPTH = -250;
const CURSOR_LIFT = 90;
/** Longest side of an item in an inventory slot, pixels (the hotbar's is 40 in a 56 slot). */
const SLOT_ITEM_PX = 34;

interface SlotEntry {
  readonly el: HTMLDivElement;
  readonly count: HTMLSpanElement;
  /** undefined for the crafting result, which is not a grid slot. */
  grid: ItemGrid | undefined;
  index: number;
  /** Counts toward the layout; hidden entries are skipped. */
  shown: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: HTMLElement,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  parent?.append(el);
  return el;
}

function itemLabel(stack: Readonly<ItemStack>): string {
  const container = containerKindOfItem(stack.type);
  const name = container !== undefined ? CONTAINER_NAMES[container] : itemDisplayName(stack.type);
  return stack.count > 1 ? `${name} x${String(stack.count)}` : name;
}

export class InventoryScreen {
  private readonly items: HotbarItems;
  private readonly views: HotbarSlotView[] = [];

  private readonly inventorySlots: SlotEntry[] = [];
  private readonly craftBoxes: SlotEntry[] = [];
  private readonly craftPluses: HTMLSpanElement[] = [];
  private readonly resultSlot: SlotEntry;
  private readonly craftAllButton: HTMLButtonElement;
  private readonly craftCycleButton: HTMLButtonElement;
  private readonly containerSlots: SlotEntry[] = [];

  private readonly mainPanel: HTMLDivElement;
  private readonly containerPanel: HTMLDivElement;
  private readonly containerTitle: HTMLDivElement;
  private readonly containerGrid: HTMLDivElement;
  private readonly takeAllButton: HTMLButtonElement;
  private readonly cursorCount: HTMLDivElement;
  private readonly tip: HTMLDivElement;

  private container: OpenContainer | undefined;
  private isOpen = false;
  private mouseX = 0;
  private mouseY = 0;
  private hovered: SlotEntry | undefined;
  private signature = "";

  constructor(
    private readonly root: HTMLElement,
    private readonly inventory: Inventory,
    private readonly crafting: CraftingBench,
    private readonly cursor: ItemCursor,
    sources: HeldItemSources,
    private readonly hooks: InventoryScreenHooks,
  ) {
    // dim + two panels + every slot + the cursor
    const poolSize = 3 + TOTAL_SLOTS + CRAFT_MAX_BOXES + 1 + MAX_CONTAINER_SLOTS + 1;
    this.items = new HotbarItems(poolSize, sources);

    const row = element("div", "inv-row", root);

    this.containerPanel = element("div", "inv-panel inv-container", row);
    this.containerTitle = element("div", "inv-title", this.containerPanel);
    this.containerGrid = element("div", "inv-grid", this.containerPanel);
    this.takeAllButton = element("button", "inv-button", this.containerPanel);
    this.takeAllButton.type = "button";
    this.takeAllButton.textContent = "Take all";
    this.takeAllButton.addEventListener("click", this.onTakeAll);

    this.mainPanel = element("div", "inv-panel inv-main", row);

    // --- crafting: _ + _ = _ ---
    const craft = element("div", "inv-craft", this.mainPanel);
    element("div", "inv-title", craft).textContent = "Crafting";
    const craftRow = element("div", "craft-row", craft);
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) {
      if (i > 0) {
        const plus = element("span", "craft-sign", craftRow);
        plus.textContent = "+";
        this.craftPluses.push(plus);
      }
      this.craftBoxes.push(this.makeSlot(craftRow, this.crafting, i));
    }
    element("span", "craft-sign craft-equals", craftRow).textContent = "=";
    const output = element("div", "craft-output", craftRow);
    this.resultSlot = this.makeSlot(output, undefined, 0);
    this.resultSlot.el.classList.add("result");
    // ALL crafts as many as the boxes pay for (onto the mouse, up to a stack).
    this.craftAllButton = element("button", "inv-button craft-all", output);
    this.craftAllButton.type = "button";
    this.craftAllButton.textContent = "ALL";
    this.craftAllButton.addEventListener("click", this.onCraftAll);
    // Stopgap for the recipe list (see items/crafting.ts): when the boxes could
    // make several things, this steps through them. "1/4" = showing the first of four.
    this.craftCycleButton = element("button", "inv-button craft-cycle", craftRow);
    this.craftCycleButton.type = "button";
    this.craftCycleButton.addEventListener("click", this.onCraftCycle);

    // --- the inventory: backpack rows on top, the hotbar as the bottom row ---
    const pack = element("div", "inv-pack", this.mainPanel);
    element("div", "inv-title", pack).textContent = "Inventory";
    const grid = element("div", "inv-grid", pack);
    grid.style.setProperty("--columns", String(INVENTORY_COLUMNS));
    const backpackRows = INVENTORY_ROWS - 1;
    for (let r = 0; r < backpackRows; r++) {
      for (let c = 0; c < INVENTORY_COLUMNS; c++) {
        this.inventorySlots.push(this.makeSlot(grid, this.inventory, HOTBAR_SLOTS + r * INVENTORY_COLUMNS + c));
      }
    }
    element("div", "inv-gap", grid);
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const entry = this.makeSlot(grid, this.inventory, i);
      const key = element("span", "slot-key");
      key.textContent = String(i + 1);
      entry.el.append(key);
      if (i === 0) {
        // The bare hands: always there, never holds anything.
        const icon = element("img", "slot-icon");
        icon.src = "/icons/unarmed.png";
        icon.alt = "";
        icon.draggable = false;
        entry.el.append(icon);
        entry.el.classList.add("locked");
      }
      this.inventorySlots.push(entry);
    }

    this.cursorCount = element("div", "inv-cursor-count", root);
    this.tip = element("div", "inv-tip", root);

    root.addEventListener("mousedown", this.onMouseDown);
    root.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("mousemove", this.onMouseMove);
    this.root.hidden = true;
  }

  get open(): boolean {
    return this.isOpen;
  }

  private makeSlot(parent: HTMLElement, grid: ItemGrid | undefined, index: number): SlotEntry {
    const el = element("div", "slot inv-slot", parent);
    const count = element("span", "slot-count", el);
    const entry: SlotEntry = { el, count, grid, index, shown: true };
    el.addEventListener("mouseenter", () => {
      this.hovered = entry;
    });
    el.addEventListener("mouseleave", () => {
      if (this.hovered === entry) this.hovered = undefined;
    });
    return entry;
  }

  /** Opens the screen; `container` is the one in reach, if any. */
  show(container: OpenContainer | undefined): void {
    this.container = container;
    this.isOpen = true;
    this.root.hidden = false;
    this.buildContainer();
    this.signature = "";
    this.refresh();
  }

  /** Closes it, putting back what is on the cursor and in the crafting boxes. */
  hide(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.hovered = undefined;
    this.container = undefined;

    const leftover = this.cursor.cancel();
    if (leftover !== undefined) this.putAway(leftover);
    for (const stack of this.crafting.takeAll()) this.putAway(stack);
  }

  private putAway(stack: ItemStack): void {
    if (!this.inventory.tryAdd(stack.type, stack.count)) this.hooks.drop(stack);
  }

  private buildContainer(): void {
    const container = this.container;
    this.containerPanel.hidden = container === undefined;
    this.containerGrid.replaceChildren();
    for (const entry of this.containerSlots) entry.shown = false;
    if (container === undefined) return;

    this.containerTitle.textContent = CONTAINER_NAMES[container.kind];
    this.containerGrid.style.setProperty("--columns", String(container.storage.columns));
    for (let i = 0; i < container.storage.size; i++) {
      let entry = this.containerSlots[i];
      if (entry === undefined) {
        entry = this.makeSlot(this.containerGrid, container.storage, i);
        this.containerSlots.push(entry);
      }
      this.containerGrid.append(entry.el);
      entry.grid = container.storage;
      entry.index = i;
      entry.shown = true;
    }
  }

  private entryFor(target: EventTarget | null): SlotEntry | undefined {
    if (!(target instanceof Element)) return undefined;
    const el = target.closest(".inv-slot");
    if (el === null) return undefined;
    const all = [...this.inventorySlots, ...this.craftBoxes, this.resultSlot, ...this.containerSlots];
    return all.find((entry) => entry.el === el && entry.shown);
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.isOpen) return;
    if (event.button === 2) {
      // Right click cancels the move.
      const leftover = this.cursor.cancel();
      if (leftover !== undefined) this.putAway(leftover);
      this.hooks.sound("cancel");
      return;
    }
    if (event.button !== 0) return;
    const entry = this.entryFor(event.target);
    if (entry === undefined) return;
    if (entry.grid === undefined) {
      // The crafting result: one craft per click, onto the mouse.
      this.craft(1);
      return;
    }
    const holding = !this.cursor.empty;
    if (this.cursor.click(entry.grid, entry.index)) this.hooks.sound(holding ? "place" : "pick");
    else if (holding) this.hooks.sound("error");
  };

  private craft(times: number): void {
    this.hooks.sound(this.crafting.craft(this.cursor, times) > 0 ? "pick" : "error");
  }

  private readonly onCraftAll = (): void => {
    this.craft(Infinity);
  };

  private readonly onCraftCycle = (): void => {
    this.crafting.cycle();
    this.hooks.sound("place");
  };

  /** Everything in the open container that fits goes into the inventory. */
  private readonly onTakeAll = (): void => {
    const container = this.container;
    if (container === undefined) return;
    this.hooks.sound(takeAll(container.storage, this.inventory) > 0 ? "pick" : "error");
  };

  private readonly onContextMenu =(event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.mouseX = event.clientX;
    this.mouseY = event.clientY;
  };

  /** Brings the DOM text up to date; cheap when nothing changed. */
  private refresh(): void {
    const storage = this.container?.storage;
    const signature = [
      this.inventory.version,
      storage?.version ?? "-",
      this.crafting.version,
      this.cursor.version,
      // What is learned changes the result without touching the boxes.
      this.crafting.result()?.type ?? "-",
    ].join("|");
    if (signature === this.signature) return;
    this.signature = signature;

    for (const entry of [...this.inventorySlots, ...this.craftBoxes, ...this.containerSlots]) {
      const stack = entry.grid?.slot(entry.index);
      entry.count.textContent = stack !== undefined && stack.count > 1 ? String(stack.count) : "";
    }

    // Boxes grow as the last one is filled: `_ + _`, then `_ + _ + _`, ...
    const visible = this.crafting.visibleBoxes;
    for (let i = 0; i < this.craftBoxes.length; i++) {
      const box = this.craftBoxes[i] as SlotEntry;
      box.shown = i < visible;
      box.el.hidden = !box.shown;
      const plus = this.craftPluses[i - 1];
      if (plus !== undefined) plus.hidden = !box.shown;
    }

    const result = this.crafting.result();
    this.resultSlot.count.textContent = result !== undefined && result.count > 1 ? String(result.count) : "";
    const options = this.crafting.options.length;
    this.craftCycleButton.hidden = options < 2;
    this.craftCycleButton.textContent = `${String(this.crafting.optionIndex + 1)}/${String(options)}`;
    this.craftAllButton.disabled = result === undefined;

    const held = this.cursor.held;
    this.cursorCount.textContent = held !== undefined && held.count > 1 ? String(held.count) : "";
  }

  /** Draws the screen's items, panels and cursor over the finished frame; call after the main pass. */
  render(renderer: WebGPURenderer, now: number): void {
    if (!this.isOpen) return;
    this.refresh();

    const views = this.views;
    views.length = 0;
    const rect = (el: HTMLElement): DOMRect => el.getBoundingClientRect();

    views.push({
      x: 0,
      y: 0,
      width: window.innerWidth,
      height: window.innerHeight,
      item: undefined,
      selected: false,
      backdropOpacity: DIM_OPACITY,
      backdropDepth: DIM_DEPTH,
    });
    for (const panel of [this.containerPanel, this.mainPanel]) {
      const r = panel.hidden ? undefined : rect(panel);
      views.push({
        x: r?.x ?? 0,
        y: r?.y ?? 0,
        width: r?.width ?? 0,
        height: r?.height ?? 0,
        item: undefined,
        selected: false,
        backdropOpacity: PANEL_OPACITY,
        backdropDepth: PANEL_DEPTH,
      });
    }

    const slotView = (entry: SlotEntry, item: ItemStack | undefined, selected: boolean): HotbarSlotView => {
      if (!entry.shown) return HIDDEN;
      const r = rect(entry.el);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        item: item?.type,
        selected,
        itemPx: SLOT_ITEM_PX,
      };
    };
    for (const entry of this.inventorySlots) {
      views.push(slotView(entry, entry.grid?.slot(entry.index), entry.index === this.inventory.selectedSlot));
    }
    for (const entry of this.craftBoxes) views.push(slotView(entry, entry.grid?.slot(entry.index), false));
    views.push(slotView(this.resultSlot, this.crafting.result(), false));
    for (let i = 0; i < MAX_CONTAINER_SLOTS; i++) {
      const entry = this.containerSlots[i];
      views.push(entry === undefined ? HIDDEN : slotView(entry, entry.grid?.slot(entry.index), false));
    }

    // The stack on the cursor floats over everything, with no backdrop of its own.
    const held = this.cursor.held;
    views.push(
      held === undefined
        ? HIDDEN
        : {
            x: this.mouseX - 20,
            y: this.mouseY - 20,
            width: 40,
            height: 40,
            item: held.type,
            selected: false,
            backdropOpacity: 0,
            itemPx: SLOT_ITEM_PX + 4,
            lift: CURSOR_LIFT,
          },
    );

    this.cursorCount.style.transform = `translate(${String(this.mouseX + 8)}px, ${String(this.mouseY + 6)}px)`;
    const hoverStack =
      held === undefined && this.hovered?.shown === true
        ? this.hovered === this.resultSlot
          ? this.crafting.result()
          : this.hovered.grid?.slot(this.hovered.index)
        : undefined;
    this.tip.hidden = hoverStack === undefined;
    if (hoverStack !== undefined) {
      this.tip.textContent = itemLabel(hoverStack);
      this.tip.style.transform = `translate(${String(this.mouseX + 14)}px, ${String(this.mouseY + 16)}px)`;
    }

    this.items.render(renderer, views, now);
  }

  dispose(): void {
    this.root.removeEventListener("mousedown", this.onMouseDown);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.items.dispose();
  }
}

/** A view the item pass skips (zero width). */
const HIDDEN: HotbarSlotView = { x: 0, y: 0, width: 0, height: 0, item: undefined, selected: false };
