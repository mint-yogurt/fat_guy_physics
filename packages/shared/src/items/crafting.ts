import { MAX_STACK, ItemType, type Inventory, type ItemGrid, type ItemStack } from "./inventory.ts";
import type { ItemCursor } from "./itemCursor.ts";

/**
 * Crafting: the inputs `_ + _ = _` (a box is added whenever the last one is
 * filled, so a recipe can take as many different items as it needs), the
 * recipes, and the book of which of them the player has worked out.
 *
 * Taking the result consumes the inputs and puts the product on the mouse
 * ({@link CraftingBench.craft}); more clicks craft more, the screen's ALL button
 * crafts as many as there is material for. Nothing here knows about the screen.
 *
 * Recipes are learned, not given: a recipe is *known* once every item it takes
 * has been in the player's inventory at least once ({@link RecipeBook}). Only
 * known recipes show up in the result box.
 *
 * STUB, for later: one material can make several things (a log is sticks,
 * toobifers, plywood or wheels). Until the real UI exists the result box shows
 * the first known recipe the boxes can pay for, and a small button cycles
 * through the others ({@link CraftingBench.cycle}). The intended UI is that
 * putting one material in the boxes lists *everything* it can make out of known
 * recipes, with what each one needs; {@link recipesUsing} is the query that list
 * is made from, and picking an entry would call {@link CraftingBench.choose}.
 */

/** Boxes shown with nothing in them: the `_ + _`. */
export const CRAFT_MIN_BOXES = 2;
/** The most items one recipe can take, for now. */
export const CRAFT_MAX_BOXES = 6;

export interface Ingredient {
  readonly type: ItemType;
  readonly count: number;
}

export interface Recipe {
  /** Each item type at most once. */
  readonly inputs: readonly Ingredient[];
  readonly output: Readonly<ItemStack>;
}

export const RECIPES: readonly Recipe[] = [
  // A log, four ways.
  { inputs: [{ type: ItemType.Log, count: 1 }], output: { type: ItemType.Stick, count: 4 } },
  { inputs: [{ type: ItemType.Log, count: 1 }], output: { type: ItemType.Toobifer, count: 2 } },
  { inputs: [{ type: ItemType.Log, count: 1 }], output: { type: ItemType.Plywood, count: 1 } },
  { inputs: [{ type: ItemType.Log, count: 1 }], output: { type: ItemType.Wheel, count: 4 } },
  {
    inputs: [
      { type: ItemType.Toobifer, count: 4 },
      { type: ItemType.Stick, count: 5 },
    ],
    output: { type: ItemType.Ladder, count: 1 },
  },
  {
    inputs: [
      { type: ItemType.Stick, count: 2 },
      { type: ItemType.Plywood, count: 1 },
      { type: ItemType.Wheel, count: 4 },
    ],
    output: { type: ItemType.Skateboard, count: 1 },
  },
  { inputs: [{ type: ItemType.MountainLightning, count: 1 }], output: { type: ItemType.Metal, count: 1 } },
  { inputs: [{ type: ItemType.Metal, count: 2 }], output: { type: ItemType.Spring, count: 1 } },
  {
    inputs: [
      { type: ItemType.Toobifer, count: 1 },
      { type: ItemType.XmasLights, count: 1 },
      { type: ItemType.Spring, count: 2 },
    ],
    output: { type: ItemType.SpringShoes, count: 1 },
  },
  {
    inputs: [
      { type: ItemType.Stick, count: 1 },
      { type: ItemType.Wheel, count: 1 },
      { type: ItemType.XmasLights, count: 3 },
    ],
    output: { type: ItemType.FishingRod, count: 1 },
  },
  // Fabric: ten leaves make a roll of toilet paper, and a dozen rolls and some metal a trampoline.
  { inputs: [{ type: ItemType.Leaf, count: 10 }], output: { type: ItemType.ToiletPaper, count: 1 } },
  {
    inputs: [
      { type: ItemType.ToiletPaper, count: 12 },
      { type: ItemType.Metal, count: 4 },
    ],
    output: { type: ItemType.Trampoline, count: 1 },
  },
];

/** Every known recipe that takes `type`: what a material can be turned into. */
export function recipesUsing(book: RecipeBook, type: ItemType): Recipe[] {
  return RECIPES.filter((recipe) => book.knows(recipe) && recipe.inputs.some((input) => input.type === type));
}

/**
 * Which item types the player has ever held, and so which recipes they know.
 * Saved with the player (save/gameSave.ts).
 */
export class RecipeBook {
  /** Bumped when a new type is learned, so a cached result can be dropped. */
  version = 0;

  private readonly seen = new Set<ItemType>();
  private lastInventoryVersion = -1;

  has(type: ItemType): boolean {
    return this.seen.has(type);
  }

  see(type: ItemType): void {
    if (this.seen.has(type)) return;
    this.seen.add(type);
    this.version++;
  }

  /** Notes whatever is in the inventory; cheap to call every frame (it looks only after a change). */
  observe(inventory: Inventory): void {
    if (inventory.version === this.lastInventoryVersion) return;
    this.lastInventoryVersion = inventory.version;
    for (let i = 0; i < inventory.size; i++) {
      const stack = inventory.slot(i);
      if (stack !== undefined) this.see(stack.type);
    }
  }

  knows(recipe: Recipe): boolean {
    return recipe.inputs.every((input) => this.seen.has(input.type));
  }

  /** For saving. */
  types(): ItemType[] {
    return [...this.seen];
  }
}

export class CraftingBench implements ItemGrid {
  readonly size = CRAFT_MAX_BOXES;
  version = 0;

  private readonly slots: (ItemStack | undefined)[] = new Array<ItemStack | undefined>(CRAFT_MAX_BOXES).fill(
    undefined,
  );
  private chosen: Recipe | undefined;
  private cachedFor = "";
  private cached: Recipe[] = [];

  constructor(private readonly book: RecipeBook) {}

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

  /** A change from outside (a click): the player has rearranged the inputs, so the choice of recipe starts over. */
  setSlot(index: number, stack: ItemStack | undefined): void {
    if (index < 0 || index >= CRAFT_MAX_BOXES) return;
    this.slots[index] = stack === undefined || stack.count <= 0 ? undefined : stack;
    this.chosen = undefined;
    this.version++;
  }

  /** Known recipes the boxes hold exactly the right kinds of item for, and enough of each for one craft. */
  get options(): readonly Recipe[] {
    const key = `${String(this.version)}|${String(this.book.version)}`;
    if (key === this.cachedFor) return this.cached;
    this.cachedFor = key;
    this.cached = RECIPES.filter((recipe) => this.book.knows(recipe) && this.craftsFor(recipe) > 0);
    return this.cached;
  }

  /** The recipe the result box is showing: the one chosen, else the first option. */
  get recipe(): Recipe | undefined {
    const options = this.options;
    return this.chosen !== undefined && options.includes(this.chosen) ? this.chosen : options[0];
  }

  /** Where {@link recipe} is among the options, 0-based. */
  get optionIndex(): number {
    const recipe = this.recipe;
    return recipe === undefined ? 0 : this.options.indexOf(recipe);
  }

  /** Shows the next recipe the boxes can make (the stopgap for the full list; see the file comment). */
  cycle(): void {
    const options = this.options;
    if (options.length < 2) return;
    this.choose(options[(this.optionIndex + 1) % options.length] as Recipe);
  }

  choose(recipe: Recipe): void {
    if (!this.options.includes(recipe)) return;
    this.chosen = recipe;
    this.version++;
  }

  /** What the result box holds: one craft of {@link recipe}. */
  result(): Readonly<ItemStack> | undefined {
    return this.recipe?.output;
  }

  /**
   * How many times the boxes pay for `recipe`: 0 unless they hold exactly its
   * kinds of item (no stranger among them), each in a big enough amount.
   */
  craftsFor(recipe: Recipe): number {
    let strangers = 0;
    let crafts = Infinity;
    for (const input of recipe.inputs) crafts = Math.min(crafts, Math.floor(this.total(input.type) / input.count));
    for (const stack of this.slots) {
      if (stack !== undefined && !recipe.inputs.some((input) => input.type === stack.type)) strangers++;
    }
    return strangers > 0 ? 0 : crafts;
  }

  /**
   * Crafts the shown recipe up to `times` times, moving the product onto the
   * cursor and the material out of the boxes. Stops at the material and at a full
   * stack; does nothing if the cursor holds something else. Returns how many
   * crafts were made.
   */
  craft(cursor: ItemCursor, times = 1): number {
    const recipe = this.recipe;
    if (recipe === undefined) return 0;
    const held = cursor.held;
    if (held !== undefined && held.type !== recipe.output.type) return 0;

    const room = Math.floor((MAX_STACK - (held?.count ?? 0)) / recipe.output.count);
    const crafts = Math.min(times, this.craftsFor(recipe), room);
    if (crafts <= 0) return 0;

    for (const input of recipe.inputs) this.consume(input.type, input.count * crafts);
    cursor.give(recipe.output.type, recipe.output.count * crafts);
    this.book.see(recipe.output.type);
    return crafts;
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
    if (out.length > 0) {
      this.chosen = undefined;
      this.version++;
    }
    return out;
  }

  private total(type: ItemType): number {
    let sum = 0;
    for (const stack of this.slots) if (stack?.type === type) sum += stack.count;
    return sum;
  }

  /** Takes `count` of `type` out of the boxes. Keeps the chosen recipe, unlike {@link setSlot}: crafting the same thing again is the point. */
  private consume(type: ItemType, count: number): void {
    let left = count;
    for (let i = 0; i < CRAFT_MAX_BOXES && left > 0; i++) {
      const stack = this.slots[i];
      if (stack === undefined || stack.type !== type) continue;
      const taken = Math.min(left, stack.count);
      left -= taken;
      this.slots[i] = taken === stack.count ? undefined : { type, count: stack.count - taken };
    }
    this.version++;
  }
}
