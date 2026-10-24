import { describe, expect, it } from "vitest";

import {
  CRAFT_MAX_BOXES,
  CRAFT_SMALL_BOX,
  CraftingBench,
  RECIPES,
  RecipeBook,
  countIn,
  craftLayout,
  recipesFor,
} from "./crafting.ts";
import { Inventory, ItemType } from "./inventory.ts";
import { ItemCursor } from "./itemCursor.ts";

/** A book that has seen these, as if they had all been carried. */
function bookWith(...types: ItemType[]): RecipeBook {
  const book = new RecipeBook();
  for (const type of types) book.see(type);
  return book;
}

describe("crafting box", () => {
  it("is 2x2 for up to four stacks and 3x3 past that, every stack on its own spot inside it", () => {
    for (let n = 0; n <= CRAFT_MAX_BOXES; n++) {
      const layout = craftLayout(n);
      expect(layout.cells).toBe(n <= CRAFT_SMALL_BOX ? 2 : 3);
      expect(layout.spots).toHaveLength(n);
      for (const [x, y] of layout.spots) {
        expect(x).toBeGreaterThanOrEqual(0.5);
        expect(y).toBeGreaterThanOrEqual(0.5);
        expect(x).toBeLessThanOrEqual(layout.cells - 0.5);
        expect(y).toBeLessThanOrEqual(layout.cells - 0.5);
      }
      // Never two stacks overlapping (a slot apart, give or take rounding).
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const [ax, ay] = layout.spots[i]!;
          const [bx, by] = layout.spots[j]!;
          expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(0.999);
        }
      }
    }
  });

  it("centres one stack, puts two on opposite corners, three in an equilateral triangle, four in the corners", () => {
    expect(craftLayout(1).spots).toEqual([[1, 1]]);
    expect(craftLayout(2).spots).toEqual([
      [0.5, 0.5],
      [1.5, 1.5],
    ]);
    const [a, b, c] = craftLayout(3).spots as [number, number][];
    const side = (p: [number, number], q: [number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1]);
    expect(side(a!, b!)).toBeCloseTo(1);
    expect(side(b!, c!)).toBeCloseTo(1);
    expect(side(c!, a!)).toBeCloseTo(1);
    expect(craftLayout(4).spots).toHaveLength(4);
  });

  it("keeps stacks in the order they went in, as others come and go", () => {
    const bench = new CraftingBench(new RecipeBook());
    bench.setSlot(bench.dropIndex(ItemType.Stick), { type: ItemType.Stick, count: 1 });
    bench.setSlot(bench.dropIndex(ItemType.Rock), { type: ItemType.Rock, count: 1 });
    bench.setSlot(bench.dropIndex(ItemType.Leaf), { type: ItemType.Leaf, count: 1 });
    expect(bench.arrangement()).toEqual([0, 1, 2]);
    bench.setSlot(0, undefined);
    // The coal fills the gap the stick left, but goes in last.
    bench.setSlot(bench.dropIndex(ItemType.Coal), { type: ItemType.Coal, count: 1 });
    expect(bench.arrangement()).toEqual([1, 2, 0]);
    expect(bench.types()).toEqual([ItemType.Rock, ItemType.Leaf, ItemType.Coal]);
    expect(bench.stackCount).toBe(3);
  });

  it("drops a stack onto one of the same item, and refuses a tenth kind", () => {
    const bench = new CraftingBench(new RecipeBook());
    bench.setSlot(0, { type: ItemType.Stick, count: 3 });
    expect(bench.dropIndex(ItemType.Stick)).toBe(0);
    expect(bench.dropIndex(ItemType.Rock)).toBe(1);
    for (let i = 0; i < CRAFT_MAX_BOXES; i++) bench.setSlot(i, { type: ItemType.Rock, count: 255 });
    expect(bench.dropIndex(ItemType.Leaf)).toBe(-1);
  });

  it("makes nothing from things no recipe uses, and gives back what was put in", () => {
    const bench = new CraftingBench(bookWith(ItemType.Stick, ItemType.Rock));
    bench.setSlot(0, { type: ItemType.Stick, count: 4 });
    bench.setSlot(1, { type: ItemType.Rock, count: 1 });
    expect(bench.result()).toBeUndefined();
    const inventory = new Inventory();
    for (const stack of bench.takeAll()) inventory.tryAdd(stack.type, stack.count);
    expect(inventory.slot(1)).toEqual({ type: ItemType.Stick, count: 4 });
    expect(bench.stackCount).toBe(0);
    expect(countIn(inventory, ItemType.Stick)).toBe(4);
  });
});

describe("recipes", () => {
  it("never take one item type twice, and never make nothing", () => {
    for (const recipe of RECIPES) {
      const types = recipe.inputs.map((input) => input.type);
      expect(new Set(types).size).toBe(types.length);
      expect(recipe.output.count).toBeGreaterThan(0);
      for (const input of recipe.inputs) expect(input.count).toBeGreaterThan(0);
    }
  });

  it("are known once every item they take has been held, whatever they make", () => {
    const book = new RecipeBook();
    const skateboard = RECIPES.find((r) => r.output.type === ItemType.Skateboard)!;
    expect(book.knows(skateboard)).toBe(false);
    book.see(ItemType.Stick);
    book.see(ItemType.Plywood);
    expect(book.knows(skateboard)).toBe(false);
    book.see(ItemType.Wheel);
    expect(book.knows(skateboard)).toBe(true);
    // Having held a skateboard before is not needed.
    expect(book.has(ItemType.Skateboard)).toBe(false);
  });

  it("are learned from the inventory, and kept", () => {
    const book = new RecipeBook();
    const inventory = new Inventory();
    inventory.tryAdd(ItemType.Log, 3);
    book.observe(inventory);
    expect(book.has(ItemType.Log)).toBe(true);
    expect(book.has(ItemType.Stick)).toBe(false);
    // Dropping the log does not unlearn it.
    inventory.setSlot(1, undefined);
    book.observe(inventory);
    expect(book.has(ItemType.Log)).toBe(true);
  });

  it("list what a material can make, from the known recipes only", () => {
    const logOnly = bookWith(ItemType.Log);
    expect(recipesFor(logOnly, [ItemType.Log]).map((r) => r.output.type)).toEqual([
      ItemType.Stick,
      ItemType.Toobifer,
      ItemType.Plywood,
      ItemType.Wheel,
    ]);
    // The ladder is not known yet: no toobifer has been held.
    expect(recipesFor(logOnly, [ItemType.Stick])).toEqual([]);
    const withToobifer = bookWith(ItemType.Stick, ItemType.Toobifer);
    expect(recipesFor(withToobifer, [ItemType.Stick]).map((r) => r.output.type)).toEqual([ItemType.Ladder]);
  });

  it("list every known recipe with nothing in the box, and narrow as more kinds go in", () => {
    const book = bookWith(ItemType.Log, ItemType.Stick, ItemType.Plywood, ItemType.Wheel, ItemType.Toobifer);
    const all = recipesFor(book);
    expect(all.length).toBe(RECIPES.filter((r) => book.knows(r)).length);
    expect(recipesFor(book, [ItemType.Stick]).map((r) => r.output.type)).toEqual([
      ItemType.Ladder,
      ItemType.Skateboard,
    ]);
    expect(recipesFor(book, [ItemType.Stick, ItemType.Wheel]).map((r) => r.output.type)).toEqual([
      ItemType.Skateboard,
    ]);
  });
});

describe("crafting", () => {
  it("shows what a log makes, but only once the player has held a log", () => {
    const unlearned = new CraftingBench(new RecipeBook());
    unlearned.setSlot(0, { type: ItemType.Log, count: 1 });
    expect(unlearned.result()).toBeUndefined();

    const known = new CraftingBench(bookWith(ItemType.Log));
    known.setSlot(0, { type: ItemType.Log, count: 1 });
    expect(known.result()).toEqual({ type: ItemType.Stick, count: 4 });
    expect(known.options).toHaveLength(4);
  });

  it("turns the wheel through the things one material can make, stopping at the ends", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    expect(bench.step(-1)).toBe(false);
    const seen: ItemType[] = [];
    for (let i = 0; i < 4; i++) {
      seen.push(bench.result()!.type);
      bench.step(1);
    }
    expect(seen).toEqual([ItemType.Stick, ItemType.Toobifer, ItemType.Plywood, ItemType.Wheel]);
    expect(bench.step(1)).toBe(false);
    expect(bench.step(-2)).toBe(true);
    expect(bench.result()?.type).toBe(ItemType.Toobifer);
  });

  it("keeps the wheel where it was when more of the material goes in", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    bench.step(2); // plywood
    bench.setSlot(0, { type: ItemType.Log, count: 5 });
    expect(bench.result()?.type).toBe(ItemType.Plywood);
  });

  it("takes the material and puts one craft on the cursor, and again on each click", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 3 });

    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 4 });
    expect(bench.slot(0)).toEqual({ type: ItemType.Log, count: 2 });

    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 8 });
    expect(bench.slot(0)).toEqual({ type: ItemType.Log, count: 1 });

    expect(bench.craft(cursor)).toBe(1);
    expect(bench.slot(0)).toBeUndefined();
    expect(bench.result()).toBeUndefined();
    expect(bench.craft(cursor)).toBe(0);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 12 });
  });

  it("keeps the recipe chosen while crafting it over and over", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 3 });
    bench.step(2); // plywood
    bench.craft(cursor);
    bench.craft(cursor);
    expect(cursor.held).toEqual({ type: ItemType.Plywood, count: 2 });
    expect(bench.result()?.type).toBe(ItemType.Plywood);
  });

  it("crafts as many as the material allows in one go", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 10 });
    bench.step(1); // toobifers, 2 a log
    expect(bench.craft(cursor, Infinity)).toBe(10);
    expect(cursor.held).toEqual({ type: ItemType.Toobifer, count: 20 });
    expect(bench.slot(0)).toBeUndefined();
  });

  it("stops at a full stack", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 200 });
    // 4 sticks a log: 63 crafts make 252, and a 64th would pass 255.
    expect(bench.craft(cursor, Infinity)).toBe(63);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 252 });
    expect(bench.slot(0)).toEqual({ type: ItemType.Log, count: 137 });
    expect(bench.craft(cursor, Infinity)).toBe(0);
  });

  it("does nothing while the cursor holds something else", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    cursor.give(ItemType.Rock, 1);
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    expect(bench.craft(cursor)).toBe(0);
    expect(bench.slot(0)).toEqual({ type: ItemType.Log, count: 1 });
    expect(cursor.held).toEqual({ type: ItemType.Rock, count: 1 });
  });

  it("needs the right amounts, and nothing else in the boxes", () => {
    const bench = new CraftingBench(bookWith(ItemType.Toobifer, ItemType.Stick, ItemType.Rock));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Toobifer, count: 4 });
    bench.setSlot(1, { type: ItemType.Stick, count: 4 });
    expect(bench.result()).toBeUndefined();

    bench.setSlot(1, { type: ItemType.Stick, count: 5 });
    expect(bench.result()).toEqual({ type: ItemType.Ladder, count: 1 });

    // An extra item no recipe uses with these spoils it.
    bench.setSlot(2, { type: ItemType.Rock, count: 1 });
    expect(bench.result()).toBeUndefined();
    bench.setSlot(2, undefined);

    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Ladder, count: 1 });
    expect(bench.slot(0)).toBeUndefined();
    expect(bench.slot(1)).toBeUndefined();
  });

  it("adds up the same item spread over several boxes, and uses them in order", () => {
    const bench = new CraftingBench(bookWith(ItemType.Toobifer, ItemType.Stick));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Toobifer, count: 3 });
    bench.setSlot(1, { type: ItemType.Stick, count: 7 });
    bench.setSlot(2, { type: ItemType.Toobifer, count: 3 });
    bench.setSlot(3, { type: ItemType.Stick, count: 3 });
    expect(bench.craft(cursor, Infinity)).toBe(1);
    expect(bench.slot(0)).toBeUndefined();
    expect(bench.slot(2)).toEqual({ type: ItemType.Toobifer, count: 2 });
    expect(bench.slot(1)).toEqual({ type: ItemType.Stick, count: 2 });
    expect(bench.slot(3)).toEqual({ type: ItemType.Stick, count: 3 });
  });

  it("makes a skateboard from sticks, plywood and wheels, and turns a can into metal", () => {
    const book = bookWith(ItemType.Stick, ItemType.Plywood, ItemType.Wheel, ItemType.MountainLightning);
    const bench = new CraftingBench(book);
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Stick, count: 2 });
    bench.setSlot(1, { type: ItemType.Plywood, count: 1 });
    bench.setSlot(2, { type: ItemType.Wheel, count: 4 });
    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Skateboard, count: 1 });

    const cans = new CraftingBench(book);
    const hand = new ItemCursor();
    cans.setSlot(0, { type: ItemType.MountainLightning, count: 2 });
    expect(cans.craft(hand, Infinity)).toBe(2);
    expect(hand.held).toEqual({ type: ItemType.Metal, count: 2 });
  });

  it("makes a spring from two metal, and spring shoes from a toobifer, lights and two springs", () => {
    const book = bookWith(ItemType.Metal, ItemType.Toobifer, ItemType.XmasLights);
    const bench = new CraftingBench(book);
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Metal, count: 5 });
    expect(bench.craft(cursor, Infinity)).toBe(2);
    expect(cursor.held).toEqual({ type: ItemType.Spring, count: 2 });
    expect(bench.slot(0)).toEqual({ type: ItemType.Metal, count: 1 });

    // Springs are learned by making them, which opens the shoes.
    expect(book.has(ItemType.Spring)).toBe(true);
    const shoes = new CraftingBench(book);
    const hand = new ItemCursor();
    shoes.setSlot(0, { type: ItemType.Toobifer, count: 1 });
    shoes.setSlot(1, { type: ItemType.XmasLights, count: 1 });
    shoes.setSlot(2, { type: ItemType.Spring, count: 1 });
    expect(shoes.result()).toBeUndefined();
    shoes.setSlot(2, { type: ItemType.Spring, count: 2 });
    expect(shoes.craft(hand)).toBe(1);
    expect(hand.held).toEqual({ type: ItemType.SpringShoes, count: 1 });
  });

  it("makes a parachute from four strings of lights and twelve rolls of toilet paper", () => {
    const bench = new CraftingBench(bookWith(ItemType.XmasLights, ItemType.ToiletPaper));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.XmasLights, count: 4 });
    bench.setSlot(1, { type: ItemType.ToiletPaper, count: 11 });
    expect(bench.result()).toBeUndefined();
    bench.setSlot(1, { type: ItemType.ToiletPaper, count: 12 });
    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Parachute, count: 1 });
  });

  it("turns ten leaves into a roll of toilet paper, and a dozen rolls and some metal into a trampoline", () => {
    const bench = new CraftingBench(bookWith(ItemType.Leaf, ItemType.ToiletPaper, ItemType.Metal));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Leaf, count: 9 });
    expect(bench.result()).toBeUndefined();
    bench.setSlot(0, { type: ItemType.Leaf, count: 25 });
    expect(bench.craft(cursor, Infinity)).toBe(2);
    expect(cursor.held).toEqual({ type: ItemType.ToiletPaper, count: 2 });
    expect(bench.slot(0)).toEqual({ type: ItemType.Leaf, count: 5 });

    const trampoline = new CraftingBench(bookWith(ItemType.ToiletPaper, ItemType.Metal));
    const hand = new ItemCursor();
    trampoline.setSlot(0, { type: ItemType.ToiletPaper, count: 12 });
    trampoline.setSlot(1, { type: ItemType.Metal, count: 3 });
    expect(trampoline.result()).toBeUndefined();
    trampoline.setSlot(1, { type: ItemType.Metal, count: 4 });
    expect(trampoline.craft(hand)).toBe(1);
    expect(hand.held).toEqual({ type: ItemType.Trampoline, count: 1 });
  });

  it("learns what it makes, so the next recipe in the chain opens up", () => {
    const book = bookWith(ItemType.Log, ItemType.Stick);
    const bench = new CraftingBench(book);
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    bench.step(1); // toobifers
    expect(bench.craft(cursor)).toBe(1);
    expect(book.has(ItemType.Toobifer)).toBe(true);
    const ladder = RECIPES.find((r) => r.output.type === ItemType.Ladder)!;
    expect(book.knows(ladder)).toBe(true);
  });

  it("sends made items to the inventory on cancel, not back into a crafting box", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log, ItemType.Stick));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Stick, count: 2 });
    cursor.click(bench, 0); // lift the sticks out of the box
    bench.setSlot(1, { type: ItemType.Log, count: 1 });
    expect(bench.craft(cursor)).toBe(1);
    expect(cursor.held).toEqual({ type: ItemType.Stick, count: 6 });
    expect(cursor.cancel()).toEqual({ type: ItemType.Stick, count: 6 });
    expect(bench.slot(0)).toBeUndefined();
  });
});
