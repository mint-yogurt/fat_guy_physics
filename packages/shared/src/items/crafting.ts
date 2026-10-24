import { MAX_STACK, ItemType, type Inventory, type ItemGrid, type ItemStack } from "./inventory.ts";
import type { ItemCursor } from "./itemCursor.ts";

/**
 * Crafting: the crafting box, the recipes, and the book of which of them the
 * player has worked out.
 *
 * The box holds up to {@link CRAFT_MAX_BOXES} stacks in no fixed place: they
 * are laid out by how many there are ({@link craftLayout}: one in the middle,
 * two on opposite corners, three in a triangle...), in the order they were put
 * in. Up to {@link CRAFT_SMALL_BOX} stacks the box is 2x2 slots, past that 3x3.
 *
 * What the box can make is every known recipe it holds exactly the material
 * for ({@link CraftingBench.options}); the screen shows them all on a wheel and
 * {@link CraftingBench.step} turns it. Taking the result consumes the inputs and
 * puts the product on the mouse ({@link CraftingBench.craft}); more clicks craft
 * more, the screen's ALL button crafts as many as there is material for.
 * Nothing here knows about the screen.
 *
 * Recipes are learned, not given: a recipe is *known* once every item it takes
 * has been in the player's inventory at least once ({@link RecipeBook}, saved
 * with the player). The recipe list shows the known ones ({@link recipesFor}).
 */

/** The most stacks the box holds: a 3x3 box. */
export const CRAFT_MAX_BOXES = 9;
/** Up to this many stacks the box is 2x2 slots; one more and it is 3x3. */
export const CRAFT_SMALL_BOX = 4;

/** Where the stacks in the crafting box sit. */
export interface CraftLayout {
  /** The box is `cells` x `cells` slots. */
  readonly cells: 2 | 3;
  /** Centre of each stack, in slots from the box's top-left, in placement order. */
  readonly spots: readonly (readonly [number, number])[];
}

const TRIANGLE_HEIGHT = Math.sqrt(3) / 2;
/** Equilateral, one slot a side, centred in the 2x2 box. */
const TRIANGLE_TOP = 1 - TRIANGLE_HEIGHT / 2;

const LAYOUTS: readonly CraftLayout[] = [
  { cells: 2, spots: [] },
  { cells: 2, spots: [[1, 1]] },
  { cells: 2, spots: [[0.5, 0.5], [1.5, 1.5]] },
  { cells: 2, spots: [[1, TRIANGLE_TOP], [0.5, TRIANGLE_TOP + TRIANGLE_HEIGHT], [1.5, TRIANGLE_TOP + TRIANGLE_HEIGHT]] },
  { cells: 2, spots: [[0.5, 0.5], [1.5, 0.5], [0.5, 1.5], [1.5, 1.5]] },
  // Past four, a 3x3 box, laid out like dice.
  { cells: 3, spots: [[0.5, 0.5], [2.5, 0.5], [1.5, 1.5], [0.5, 2.5], [2.5, 2.5]] },
  { cells: 3, spots: [[0.5, 0.5], [2.5, 0.5], [0.5, 1.5], [2.5, 1.5], [0.5, 2.5], [2.5, 2.5]] },
  { cells: 3, spots: [[0.5, 0.5], [2.5, 0.5], [0.5, 1.5], [1.5, 1.5], [2.5, 1.5], [0.5, 2.5], [2.5, 2.5]] },
  {
    cells: 3,
    spots: [[0.5, 0.5], [1.5, 0.5], [2.5, 0.5], [0.5, 1.5], [2.5, 1.5], [0.5, 2.5], [1.5, 2.5], [2.5, 2.5]],
  },
  {
    cells: 3,
    spots: [
      [0.5, 0.5], [1.5, 0.5], [2.5, 0.5],
      [0.5, 1.5], [1.5, 1.5], [2.5, 1.5],
      [0.5, 2.5], [1.5, 2.5], [2.5, 2.5],
    ],
  },
];

/** How `count` stacks sit in the crafting box. */
export function craftLayout(count: number): CraftLayout {
  return LAYOUTS[Math.max(0, Math.min(CRAFT_MAX_BOXES, count))] as CraftLayout;
}

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
  // Four strings of lights for the lines, a dozen rolls for the canopy.
  {
    inputs: [
      { type: ItemType.XmasLights, count: 4 },
      { type: ItemType.ToiletPaper, count: 12 },
    ],
    output: { type: ItemType.Parachute, count: 1 },
  },
];

/**
 * The known recipes that take every one of `types`: the whole book when
 * `types` is empty, narrowing as more kinds of item go in the box.
 */
export function recipesFor(book: RecipeBook, types: readonly ItemType[] = []): Recipe[] {
  return RECIPES.filter(
    (recipe) => book.knows(recipe) && types.every((type) => recipe.inputs.some((input) => input.type === type)),
  );
}

/** How many of `type` a grid holds. */
export function countIn(grid: ItemGrid, type: ItemType): number {
  let sum = 0;
  for (let i = 0; i < grid.size; i++) {
    const stack = grid.slot(i);
    if (stack?.type === type) sum += stack.count;
  }
  return sum;
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
  /** When each slot was filled, so the stacks keep their places in the layout as others come and go. */
  private readonly placedAt: number[] = new Array<number>(CRAFT_MAX_BOXES).fill(0);
  private placements = 0;
  private chosen: Recipe | undefined;
  private cachedFor = "";
  private cached: Recipe[] = [];

  constructor(private readonly book: RecipeBook) {}

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  accepts(index: number, _type: ItemType): boolean {
    return index >= 0 && index < CRAFT_MAX_BOXES;
  }

  /** A change from outside (a click). The recipe chosen on the wheel stays chosen while the box can still make it. */
  setSlot(index: number, stack: ItemStack | undefined): void {
    if (index < 0 || index >= CRAFT_MAX_BOXES) return;
    const next = stack === undefined || stack.count <= 0 ? undefined : stack;
    if (this.slots[index] === undefined && next !== undefined) this.placedAt[index] = ++this.placements;
    this.slots[index] = next;
    this.version++;
  }

  /** How many stacks are in the box. */
  get stackCount(): number {
    let count = 0;
    for (const stack of this.slots) if (stack !== undefined) count++;
    return count;
  }

  /** The filled slots in the order they were filled: the i-th one sits at `craftLayout(n).spots[i]`. */
  arrangement(): number[] {
    const filled: number[] = [];
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) if (this.slots[i] !== undefined) filled.push(i);
    return filled.sort((a, b) => (this.placedAt[a] as number) - (this.placedAt[b] as number));
  }

  /**
   * Where a stack of `type` dropped anywhere on the box goes: onto a stack of
   * the same item with room, else into an empty slot. -1 when the box is full.
   */
  dropIndex(type: ItemType): number {
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) {
      const stack = this.slots[i];
      if (stack?.type === type && stack.count < MAX_STACK) return i;
    }
    return this.slots.indexOf(undefined);
  }

  /** The kinds of item in the box, each once. */
  types(): ItemType[] {
    const types: ItemType[] = [];
    for (const index of this.arrangement()) {
      const type = (this.slots[index] as ItemStack).type;
      if (!types.includes(type)) types.push(type);
    }
    return types;
  }

  /** Known recipes the box holds exactly the right kinds of item for, and enough of each for one craft. */
  get options(): readonly Recipe[] {
    const key = `${String(this.version)}|${String(this.book.version)}`;
    if (key === this.cachedFor) return this.cached;
    this.cachedFor = key;
    this.cached = RECIPES.filter((recipe) => this.book.knows(recipe) && this.craftsFor(recipe) > 0);
    return this.cached;
  }

  /** The recipe the wheel is showing: the one chosen, else the first option. */
  get recipe(): Recipe | undefined {
    const options = this.options;
    return this.chosen !== undefined && options.includes(this.chosen) ? this.chosen : options[0];
  }

  /** Where {@link recipe} is among the options, 0-based. */
  get optionIndex(): number {
    const recipe = this.recipe;
    return recipe === undefined ? 0 : this.options.indexOf(recipe);
  }

  /** Turns the wheel `by` options (negative = up), stopping at either end. False if it did not move. */
  step(by: number): boolean {
    const options = this.options;
    const index = Math.max(0, Math.min(options.length - 1, this.optionIndex + by));
    if (options.length === 0 || index === this.optionIndex) return false;
    this.choose(options[index] as Recipe);
    return true;
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
   * How many times the box pay for `recipe`: 0 unless they hold exactly its
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
   * cursor and the material out of the box. Stops at the material and at a full
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

  /** Empties the box, returning what was in them (the screen puts it back in the inventory). */
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

  private total(type: ItemType): number {
    let sum = 0;
    for (const stack of this.slots) if (stack?.type === type) sum += stack.count;
    return sum;
  }

  /** Takes `count` of `type` out of the box. */
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
