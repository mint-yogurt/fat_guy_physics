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
import {
  CRAFT_MAX_BOXES,
  RECIPES,
  countIn,
  craftLayout,
  recipesFor,
  type CraftingBench,
  type Recipe,
  type RecipeBook,
} from "@fgp/shared/items/crafting";
import type { ItemCursor } from "@fgp/shared/items/itemCursor";
import type { WebGPURenderer } from "three/webgpu";

import type { HeldItemSources } from "../render/heldItems.ts";
import { HotbarItems, type HotbarSlotView } from "../render/hotbarItems.ts";

/**
 * The inventory screen, left to right: the container in reach (if any), GEAR
 * (empty for now), the main panel (the crafting box, its output wheel, and the
 * inventory grid under them) and RECIPES (every known recipe, narrowed to the
 * ones using what is in the crafting box).
 *
 * The crafting box has no fixed slots: whatever is dropped anywhere on it is
 * laid out by how many stacks there are (shared `craftLayout`), and the stacks
 * slide to their spots with a CSS transition. The wheel lists everything the
 * box can make; the arrows (or the mouse wheel) turn it, and a click on the
 * middle option crafts one.
 *
 * Same trick as the hotbar (ui/hotbar.ts): the DOM holds borders, text and
 * hit-testing, and everything translucent -- the dimming, the panels, the
 * slot backdrops -- plus the item meshes are drawn into the canvas by a
 * {@link HotbarItems} pass, because the canvas sits beneath the DOM and a
 * translucent CSS fill would dim the items. Sizes all come from the DOM rects,
 * so the UI scale (`--ui-scale` in ui.css) needs nothing here.
 *
 * The clicking rules are the item cursor's (shared/items/itemCursor.ts); this
 * file only turns mouse events into `cursor.click(grid, index)`. A stack can be
 * clicked up and clicked down, or dragged: let go over another place and it
 * goes there.
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
/** An item's longest side as a share of its slot (34 px in a 46 px slot). */
const ITEM_FILL = 34 / 46;
/** The inventory slot's unscaled size in ui.css; offsets around the mouse are in these units. */
const SLOT_CSS_PX = 46;
/** How far the mouse must move while held down for letting go to count as a drag. */
const DRAG_MIN_PX = 6;
/** The wheel's neighbours above and below the middle are drawn this much smaller. */
const WHEEL_SHRINK = 0.3;
/** Fully visible from the window's edge inward by this many option heights; shrinks to nothing past it. */
const WHEEL_FADE = 0.5;

const SlotRole = {
  /** A slot of an {@link ItemGrid}: the inventory or a container. */
  Grid: 0,
  /** A stack in the crafting box. */
  Box: 1,
  /** An option on the output wheel; `index` is into the bench's options. */
  Option: 2,
} as const;
type SlotRole = (typeof SlotRole)[keyof typeof SlotRole];

interface SlotEntry {
  readonly el: HTMLDivElement;
  readonly count: HTMLSpanElement;
  readonly role: SlotRole;
  grid: ItemGrid | undefined;
  index: number;
  /** Counts toward the layout; hidden entries are skipped. */
  shown: boolean;
}

interface RecipeRow {
  readonly recipe: Recipe;
  readonly el: HTMLDivElement;
  readonly icon: HTMLDivElement;
  readonly needs: HTMLDivElement;
  readonly marks: HTMLSpanElement[];
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

function itemName(type: ItemStack["type"]): string {
  const container = containerKindOfItem(type);
  return container !== undefined ? CONTAINER_NAMES[container] : itemDisplayName(type);
}

function itemLabel(stack: Readonly<ItemStack>): string {
  const name = itemName(stack.type);
  return stack.count > 1 ? `${name} x${String(stack.count)}` : name;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class InventoryScreen {
  private readonly items: HotbarItems;
  private readonly views: HotbarSlotView[] = [];

  private readonly inventorySlots: SlotEntry[] = [];
  private readonly boxSlots: SlotEntry[] = [];
  private readonly optionSlots: SlotEntry[] = [];
  private readonly containerSlots: SlotEntry[] = [];
  private readonly recipeRows: RecipeRow[] = [];
  private readonly expanded = new Set<Recipe>();

  private readonly mainPanel: HTMLDivElement;
  private readonly gearPanel: HTMLDivElement;
  private readonly recipesPanel: HTMLDivElement;
  private readonly recipeList: HTMLDivElement;
  private readonly recipeEmpty: HTMLDivElement;
  private readonly craftBox: HTMLDivElement;
  private readonly wheel: HTMLDivElement;
  private readonly wheelStrip: HTMLDivElement;
  private readonly wheelUp: HTMLButtonElement;
  private readonly wheelDown: HTMLButtonElement;
  private readonly craftAllButton: HTMLButtonElement;
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
  /** A press that lifted a stack: where, and from which place, so letting go elsewhere drops it there. */
  private drag: { x: number; y: number; from: Element | null } | undefined;
  private signature = "";
  private expandedVersion = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly inventory: Inventory,
    private readonly crafting: CraftingBench,
    private readonly book: RecipeBook,
    private readonly cursor: ItemCursor,
    sources: HeldItemSources,
    private readonly hooks: InventoryScreenHooks,
  ) {
    // dim + four panels + box + wheel window, every slot, every option and recipe icon, the cursor
    const poolSize = 7 + TOTAL_SLOTS + CRAFT_MAX_BOXES + RECIPES.length * 2 + MAX_CONTAINER_SLOTS + 1;
    this.items = new HotbarItems(poolSize, sources);

    const row = element("div", "inv-row", root);

    this.containerPanel = element("div", "inv-panel inv-container", row);
    this.containerTitle = element("div", "inv-title", this.containerPanel);
    this.containerGrid = element("div", "inv-grid", this.containerPanel);
    this.takeAllButton = element("button", "inv-button", this.containerPanel);
    this.takeAllButton.type = "button";
    this.takeAllButton.textContent = "Take all";
    this.takeAllButton.addEventListener("click", this.onTakeAll);

    // --- gear: where worn things will go (shared/items/gear.ts); empty for now ---
    this.gearPanel = element("div", "inv-panel inv-gear", row);
    element("div", "inv-title", this.gearPanel).textContent = "GEAR";

    this.mainPanel = element("div", "inv-panel inv-main", row);

    // --- crafting: the box, =, the output wheel and its buttons ---
    const craft = element("div", "inv-craft", this.mainPanel);
    element("div", "inv-title", craft).textContent = "Crafting";
    const craftRow = element("div", "craft-row", craft);
    const area = element("div", "craft-area", craftRow);
    this.craftBox = element("div", "craft-box", area);
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) {
      const entry = this.makeSlot(this.craftBox, SlotRole.Box, this.crafting, i);
      entry.el.classList.add("craft-item");
      entry.shown = false;
      entry.el.hidden = true;
      this.boxSlots.push(entry);
    }
    element("span", "craft-sign", craftRow).textContent = "=";

    // A slot-machine wheel: the strip of options slides so the chosen one sits
    // in the middle row, with its neighbours showing above and below.
    this.wheel = element("div", "craft-wheel", craftRow);
    this.wheelStrip = element("div", "wheel-strip", this.wheel);
    for (let i = 0; i < RECIPES.length; i++) {
      const entry = this.makeSlot(this.wheelStrip, SlotRole.Option, undefined, i);
      entry.el.classList.add("wheel-option");
      this.optionSlots.push(entry);
    }
    element("div", "wheel-frame", this.wheel);
    this.wheel.addEventListener("wheel", this.onWheelScroll, { passive: true });

    const controls = element("div", "craft-controls", craftRow);
    this.wheelUp = element("button", "inv-button wheel-arrow", controls);
    this.wheelUp.type = "button";
    this.wheelUp.textContent = "▲";
    this.wheelUp.addEventListener("click", () => {
      this.turnWheel(-1);
    });
    // ALL crafts as many as the box pays for (onto the mouse, up to a stack).
    this.craftAllButton = element("button", "inv-button craft-all", controls);
    this.craftAllButton.type = "button";
    this.craftAllButton.textContent = "ALL";
    this.craftAllButton.addEventListener("click", this.onCraftAll);
    this.wheelDown = element("button", "inv-button wheel-arrow", controls);
    this.wheelDown.type = "button";
    this.wheelDown.textContent = "▼";
    this.wheelDown.addEventListener("click", () => {
      this.turnWheel(1);
    });

    // --- the inventory: backpack rows on top, the hotbar as the bottom row ---
    const pack = element("div", "inv-pack", this.mainPanel);
    element("div", "inv-title", pack).textContent = "Inventory";
    const grid = element("div", "inv-grid", pack);
    grid.style.setProperty("--columns", String(INVENTORY_COLUMNS));
    const backpackRows = INVENTORY_ROWS - 1;
    for (let r = 0; r < backpackRows; r++) {
      for (let c = 0; c < INVENTORY_COLUMNS; c++) {
        this.inventorySlots.push(
          this.makeSlot(grid, SlotRole.Grid, this.inventory, HOTBAR_SLOTS + r * INVENTORY_COLUMNS + c),
        );
      }
    }
    element("div", "inv-gap", grid);
    for (let i = 0; i < HOTBAR_SLOTS; i++) {
      const entry = this.makeSlot(grid, SlotRole.Grid, this.inventory, i);
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

    // --- recipes: one row per recipe, shown once known; click a row for what it takes ---
    this.recipesPanel = element("div", "inv-panel inv-recipes", row);
    element("div", "inv-title", this.recipesPanel).textContent = "RECIPES";
    this.recipeList = element("div", "recipe-list", this.recipesPanel);
    for (const recipe of RECIPES) this.recipeRows.push(this.makeRecipeRow(recipe));
    this.recipeEmpty = element("div", "recipe-empty", this.recipeList);

    this.cursorCount = element("div", "inv-cursor-count", root);
    this.tip = element("div", "inv-tip", root);

    root.addEventListener("mousedown", this.onMouseDown);
    root.addEventListener("mouseup", this.onMouseUp);
    root.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("mousemove", this.onMouseMove);
    this.root.hidden = true;
  }

  get open(): boolean {
    return this.isOpen;
  }

  private makeSlot(parent: HTMLElement, role: SlotRole, grid: ItemGrid | undefined, index: number): SlotEntry {
    const el = element("div", "slot inv-slot", parent);
    const count = element("span", "slot-count", el);
    const entry: SlotEntry = { el, count, role, grid, index, shown: true };
    el.addEventListener("mouseenter", () => {
      this.hovered = entry;
    });
    el.addEventListener("mouseleave", () => {
      if (this.hovered === entry) this.hovered = undefined;
    });
    return entry;
  }

  private makeRecipeRow(recipe: Recipe): RecipeRow {
    const el = element("div", "recipe", this.recipeList);
    const head = element("div", "recipe-head", el);
    const icon = element("div", "recipe-icon", head);
    if (recipe.output.count > 1) element("span", "slot-count", icon).textContent = String(recipe.output.count);
    element("span", "recipe-name", head).textContent = capitalized(itemName(recipe.output.type));
    const needs = element("div", "recipe-needs", el);
    needs.hidden = true;
    const marks: HTMLSpanElement[] = [];
    for (const input of recipe.inputs) {
      const line = element("div", "recipe-need", needs);
      element("span", "need-text", line).textContent = `${String(input.count)} ${itemName(input.type)}`;
      marks.push(element("span", "need-mark", line));
    }
    head.addEventListener("click", () => {
      if (this.expanded.has(recipe)) this.expanded.delete(recipe);
      else this.expanded.add(recipe);
      this.expandedVersion++;
      this.hooks.sound("place");
    });
    return { recipe, el, icon, needs, marks };
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

  /** Closes it, putting back what is on the cursor and in the crafting box. */
  hide(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.hidden = true;
    this.hovered = undefined;
    this.drag = undefined;
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
    // The extra panel may not fit at full UI scale; ui.css shrinks the screen for it.
    this.root.classList.toggle("with-container", container !== undefined);
    this.containerGrid.replaceChildren();
    for (const entry of this.containerSlots) entry.shown = false;
    if (container === undefined) return;

    this.containerTitle.textContent = CONTAINER_NAMES[container.kind];
    this.containerGrid.style.setProperty("--columns", String(container.storage.columns));
    for (let i = 0; i < container.storage.size; i++) {
      let entry = this.containerSlots[i];
      if (entry === undefined) {
        entry = this.makeSlot(this.containerGrid, SlotRole.Grid, container.storage, i);
        this.containerSlots.push(entry);
      }
      this.containerGrid.append(entry.el);
      entry.grid = container.storage;
      entry.index = i;
      entry.shown = true;
    }
  }

  private entryFor(target: Element): SlotEntry | undefined {
    const el = target.closest(".inv-slot");
    if (el === null) return undefined;
    const all = [...this.inventorySlots, ...this.boxSlots, ...this.optionSlots, ...this.containerSlots];
    return all.find((entry) => entry.el === el && entry.shown);
  }

  /** The place a press or a let-go lands on: a slot, else the crafting box as a whole. */
  private placeOf(target: EventTarget | null): Element | null {
    if (!(target instanceof Element)) return null;
    return target.closest(".inv-slot") ?? target.closest(".craft-area");
  }

  /** What a slot shows. */
  private stackOf(entry: SlotEntry): Readonly<ItemStack> | undefined {
    if (entry.role === SlotRole.Option) return this.crafting.options[entry.index]?.output;
    return entry.grid?.slot(entry.index);
  }

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.isOpen) return;
    if (event.button === 2) {
      // Right click cancels the move.
      this.drag = undefined;
      const leftover = this.cursor.cancel();
      if (leftover !== undefined) this.putAway(leftover);
      this.hooks.sound("cancel");
      return;
    }
    if (event.button !== 0) return;
    const wasEmpty = this.cursor.empty;
    this.act(event.target);
    this.drag =
      wasEmpty && !this.cursor.empty
        ? { x: event.clientX, y: event.clientY, from: this.placeOf(event.target) }
        : undefined;
  };

  /** Letting go after dragging a stack off somewhere puts it down there, like a second click. */
  private readonly onMouseUp = (event: MouseEvent): void => {
    const drag = this.drag;
    this.drag = undefined;
    if (!this.isOpen || drag === undefined || event.button !== 0 || this.cursor.empty) return;
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < DRAG_MIN_PX) return;
    const place = this.placeOf(event.target);
    if (place === null || place === drag.from) return;
    // The wheel is for clicking: dropping a stack on it should not craft or turn it.
    if (place.classList.contains("wheel-option")) return;
    this.act(event.target);
  };

  /** A left click (or a drag let go) on whatever is under the mouse. */
  private act(target: EventTarget | null): void {
    if (!(target instanceof Element)) return;
    const entry = this.entryFor(target);
    if (entry?.role === SlotRole.Option) {
      this.clickOption(entry.index);
      return;
    }
    if (entry?.role === SlotRole.Grid && entry.grid !== undefined) {
      const holding = !this.cursor.empty;
      if (this.cursor.click(entry.grid, entry.index)) this.hooks.sound(holding ? "place" : "pick");
      else if (holding) this.hooks.sound("error");
      return;
    }
    if (target.closest(".craft-area") !== null) this.clickBox(entry);
  }

  /**
   * The crafting box: a held stack dropped anywhere on it goes in (onto a stack
   * of the same item, else a spot of its own); with nothing held, a click on a
   * stack lifts it out.
   */
  private clickBox(entry: SlotEntry | undefined): void {
    const held = this.cursor.held;
    if (held === undefined) {
      if (entry !== undefined && this.cursor.click(this.crafting, entry.index)) this.hooks.sound("pick");
      return;
    }
    let index = this.crafting.dropIndex(held.type);
    // A full box: swap with the stack clicked on, as a grid slot would.
    if (index < 0 && entry !== undefined) index = entry.index;
    this.hooks.sound(index >= 0 && this.cursor.click(this.crafting, index) ? "place" : "error");
  }

  /** The middle option crafts one; any other turns the wheel to it. */
  private clickOption(index: number): void {
    if (index === this.crafting.optionIndex) {
      this.craft(1);
      return;
    }
    this.turnWheel(index - this.crafting.optionIndex);
  }

  private turnWheel(by: number): void {
    if (this.crafting.step(by)) this.hooks.sound("place");
  }

  private craft(times: number): void {
    this.hooks.sound(this.crafting.craft(this.cursor, times) > 0 ? "pick" : "error");
  }

  private readonly onCraftAll = (): void => {
    this.craft(Infinity);
  };

  private readonly onWheelScroll = (event: WheelEvent): void => {
    if (event.deltaY !== 0) this.turnWheel(Math.sign(event.deltaY));
  };

  /** Everything in the open container that fits goes into the inventory. */
  private readonly onTakeAll = (): void => {
    const container = this.container;
    if (container === undefined) return;
    this.hooks.sound(takeAll(container.storage, this.inventory) > 0 ? "pick" : "error");
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.mouseX = event.clientX;
    this.mouseY = event.clientY;
  };

  /** How many of `type` the player has to craft with: in the inventory, the box, and on the mouse. */
  private have(type: ItemStack["type"]): number {
    const held = this.cursor.held;
    return (
      countIn(this.inventory, type) + countIn(this.crafting, type) + (held?.type === type ? held.count : 0)
    );
  }

  /** Brings the DOM up to date; cheap when nothing changed. */
  private refresh(): void {
    const storage = this.container?.storage;
    const signature = [
      this.inventory.version,
      storage?.version ?? "-",
      this.crafting.version,
      this.cursor.version,
      // What is learned changes the options and the list without touching the box.
      this.book.version,
      this.expandedVersion,
    ].join("|");
    if (signature === this.signature) return;
    this.signature = signature;

    for (const entry of [...this.inventorySlots, ...this.boxSlots, ...this.containerSlots]) {
      const stack = entry.grid?.slot(entry.index);
      entry.count.textContent = stack !== undefined && stack.count > 1 ? String(stack.count) : "";
    }

    // The box: each stack on its spot for how many there are; CSS slides them there.
    const order = this.crafting.arrangement();
    const layout = craftLayout(order.length);
    this.craftBox.style.setProperty("--cells", String(layout.cells));
    for (let i = 0; i < this.boxSlots.length; i++) {
      const entry = this.boxSlots[i] as SlotEntry;
      const spot = layout.spots[order.indexOf(i)];
      entry.shown = spot !== undefined;
      entry.el.hidden = !entry.shown;
      if (spot === undefined) continue;
      entry.el.style.setProperty("--x", String(spot[0]));
      entry.el.style.setProperty("--y", String(spot[1]));
    }

    // The wheel: one option per slot of the strip, the strip slid to the chosen one.
    const options = this.crafting.options;
    const at = this.crafting.optionIndex;
    this.wheelStrip.style.setProperty("--at", String(at));
    for (let i = 0; i < this.optionSlots.length; i++) {
      const entry = this.optionSlots[i] as SlotEntry;
      const output = options[i]?.output;
      entry.shown = output !== undefined;
      entry.el.hidden = !entry.shown;
      entry.el.classList.toggle("current", i === at);
      entry.count.textContent = output !== undefined && output.count > 1 ? String(output.count) : "";
    }
    this.wheelUp.disabled = at <= 0;
    this.wheelDown.disabled = at >= options.length - 1;
    this.craftAllButton.disabled = options.length === 0;

    // The recipes: all known, or only those taking everything in the box.
    const types = this.crafting.types();
    const listed = new Set(recipesFor(this.book, types));
    for (const row of this.recipeRows) {
      row.el.hidden = !listed.has(row.recipe);
      const open = this.expanded.has(row.recipe);
      row.el.classList.toggle("open", open);
      row.needs.hidden = !open;
      if (!open) continue;
      row.recipe.inputs.forEach((input, i) => {
        const mark = row.marks[i] as HTMLSpanElement;
        const enough = this.have(input.type) >= input.count;
        mark.textContent = enough ? "✓" : "✗";
        mark.className = enough ? "need-mark need-ok" : "need-mark need-bad";
      });
    }
    this.recipeEmpty.hidden = listed.size > 0;
    this.recipeEmpty.textContent =
      types.length === 0 ? "Pick up materials to learn recipes." : "No known recipe uses these together.";

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
    const backdrop = (el: HTMLElement, opacity: number, depth: number): HotbarSlotView => {
      if (el.hidden) return HIDDEN;
      const r = rect(el);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        item: undefined,
        selected: false,
        backdropOpacity: opacity,
        backdropDepth: depth,
      };
    };

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
    for (const panel of [this.containerPanel, this.gearPanel, this.mainPanel, this.recipesPanel]) {
      views.push(backdrop(panel, PANEL_OPACITY, PANEL_DEPTH));
    }
    // The box and the wheel's window are one backdrop each; their stacks slide over them.
    views.push(backdrop(this.craftBox, 0.3, PANEL_DEPTH + 50));
    views.push(backdrop(this.wheel, 0.42, PANEL_DEPTH + 50));

    const slotView = (entry: SlotEntry, item: Readonly<ItemStack> | undefined, selected: boolean): HotbarSlotView => {
      if (!entry.shown) return HIDDEN;
      const r = rect(entry.el);
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        item: item?.type,
        selected,
        itemPx: r.width * ITEM_FILL,
      };
    };
    for (const entry of this.inventorySlots) {
      views.push(slotView(entry, entry.grid?.slot(entry.index), entry.index === this.inventory.selectedSlot));
    }
    for (const entry of this.boxSlots) views.push(slotView(entry, entry.grid?.slot(entry.index), false));

    // Wheel options: full size in the middle row, smaller toward the window's edges, gone past them.
    const wheel = rect(this.wheel);
    const wheelMid = wheel.y + wheel.height / 2;
    for (const entry of this.optionSlots) {
      if (!entry.shown) {
        views.push(HIDDEN);
        continue;
      }
      const r = rect(entry.el);
      const pitch = (wheel.height - r.height) / 2;
      const away = pitch > 0 ? Math.abs(r.y + r.height / 2 - wheelMid) / pitch : 0;
      const size = away <= 1 ? 1 - WHEEL_SHRINK * away : (1 - WHEEL_SHRINK) * Math.max(0, 1 - (away - 1) / WHEEL_FADE);
      views.push(
        size <= 0.02
          ? HIDDEN
          : {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              item: this.stackOf(entry)?.type,
              selected: false,
              backdropOpacity: 0,
              itemPx: r.width * ITEM_FILL * size,
            },
      );
    }

    for (let i = 0; i < MAX_CONTAINER_SLOTS; i++) {
      const entry = this.containerSlots[i];
      views.push(entry === undefined ? HIDDEN : slotView(entry, entry.grid?.slot(entry.index), false));
    }

    // Recipe pictures, only while wholly inside the scrolled list.
    const list = rect(this.recipeList);
    for (let i = 0; i < RECIPES.length; i++) {
      const row = this.recipeRows[i];
      if (row === undefined || row.el.hidden) {
        views.push(HIDDEN);
        continue;
      }
      const r = rect(row.icon);
      const inside = r.y >= list.y - 1 && r.bottom <= list.bottom + 1;
      views.push(
        inside
          ? {
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
              item: row.recipe.output.type,
              selected: false,
              backdropOpacity: 0,
              itemPx: r.width * ITEM_FILL,
            }
          : HIDDEN,
      );
    }

    // The stack on the cursor floats over everything, with no backdrop of its own.
    // Sized like an inventory slot, so it follows the UI scale.
    const slotPx = this.inventorySlots[0] === undefined ? SLOT_CSS_PX : rect(this.inventorySlots[0].el).width;
    const unit = slotPx / SLOT_CSS_PX;
    const held = this.cursor.held;
    const cursorPx = slotPx * 0.9;
    views.push(
      held === undefined
        ? HIDDEN
        : {
            x: this.mouseX - cursorPx / 2,
            y: this.mouseY - cursorPx / 2,
            width: cursorPx,
            height: cursorPx,
            item: held.type,
            selected: false,
            backdropOpacity: 0,
            itemPx: cursorPx * ITEM_FILL * 1.1,
            lift: CURSOR_LIFT,
          },
    );

    this.cursorCount.style.transform = `translate(${String(this.mouseX + 8 * unit)}px, ${String(this.mouseY + 6 * unit)}px)`;
    const hoverStack = held === undefined && this.hovered?.shown === true ? this.stackOf(this.hovered) : undefined;
    this.tip.hidden = hoverStack === undefined;
    if (hoverStack !== undefined) {
      this.tip.textContent = itemLabel(hoverStack);
      this.tip.style.transform = `translate(${String(this.mouseX + 14 * unit)}px, ${String(this.mouseY + 16 * unit)}px)`;
    }

    this.items.render(renderer, views, now);
  }

  dispose(): void {
    this.root.removeEventListener("mousedown", this.onMouseDown);
    this.root.removeEventListener("mouseup", this.onMouseUp);
    this.root.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("mousemove", this.onMouseMove);
    this.wheel.removeEventListener("wheel", this.onWheelScroll);
    this.items.dispose();
  }
}

/** A view the item pass skips (zero width). */
const HIDDEN: HotbarSlotView = { x: 0, y: 0, width: 0, height: 0, item: undefined, selected: false };
