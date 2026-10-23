import { describe, expect, it } from "vitest";

import {
  CRAFT_MAX_BOXES,
  CRAFT_MIN_BOXES,
  CraftingBench,
  RECIPES,
  RecipeBook,
  recipesUsing,
} from "./crafting.ts";
import { Inventory, ItemType } from "./inventory.ts";
import { ItemCursor } from "./itemCursor.ts";

/** A book that has seen these, as if they had all been carried. */
function bookWith(...types: ItemType[]): RecipeBook {
  const book = new RecipeBook();
  for (const type of types) book.see(type);
  return book;
}

describe("crafting bench boxes", () => {
  it("shows two boxes, and another each time the last is filled", () => {
    const bench = new CraftingBench(new RecipeBook());
    expect(bench.visibleBoxes).toBe(CRAFT_MIN_BOXES);
    bench.setSlot(0, { type: ItemType.Stick, count: 1 });
    expect(bench.visibleBoxes).toBe(2);
    bench.setSlot(1, { type: ItemType.Rock, count: 1 });
    expect(bench.visibleBoxes).toBe(3);
    bench.setSlot(2, { type: ItemType.Leaf, count: 1 });
    expect(bench.visibleBoxes).toBe(4);
    bench.setSlot(5, { type: ItemType.Leaf, count: 1 });
    expect(bench.visibleBoxes).toBe(CRAFT_MAX_BOXES);
  });

  it("makes nothing from things no recipe uses, and gives back what was put in", () => {
    const bench = new CraftingBench(bookWith(ItemType.Stick, ItemType.Rock));
    bench.setSlot(0, { type: ItemType.Stick, count: 4 });
    bench.setSlot(1, { type: ItemType.Rock, count: 1 });
    expect(bench.result()).toBeUndefined();
    const inventory = new Inventory();
    for (const stack of bench.takeAll()) inventory.tryAdd(stack.type, stack.count);
    expect(inventory.slot(1)).toEqual({ type: ItemType.Stick, count: 4 });
    expect(bench.visibleBoxes).toBe(CRAFT_MIN_BOXES);
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
    expect(recipesUsing(logOnly, ItemType.Log).map((r) => r.output.type)).toEqual([
      ItemType.Stick,
      ItemType.Toobifer,
      ItemType.Plywood,
      ItemType.Wheel,
    ]);
    // The ladder is not known yet: no toobifer has been held.
    expect(recipesUsing(logOnly, ItemType.Stick)).toEqual([]);
    const withToobifer = bookWith(ItemType.Stick, ItemType.Toobifer);
    expect(recipesUsing(withToobifer, ItemType.Stick).map((r) => r.output.type)).toEqual([ItemType.Ladder]);
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

  it("cycles through the things one material can make", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    const seen: ItemType[] = [];
    for (let i = 0; i < 5; i++) {
      seen.push(bench.result()!.type);
      bench.cycle();
    }
    expect(seen).toEqual([ItemType.Stick, ItemType.Toobifer, ItemType.Plywood, ItemType.Wheel, ItemType.Stick]);
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
    bench.cycle();
    bench.cycle(); // plywood
    bench.craft(cursor);
    bench.craft(cursor);
    expect(cursor.held).toEqual({ type: ItemType.Plywood, count: 2 });
    expect(bench.result()?.type).toBe(ItemType.Plywood);
  });

  it("crafts as many as the material allows in one go", () => {
    const bench = new CraftingBench(bookWith(ItemType.Log));
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 10 });
    bench.cycle(); // toobifers, 2 a log
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

  it("learns what it makes, so the next recipe in the chain opens up", () => {
    const book = bookWith(ItemType.Log, ItemType.Stick);
    const bench = new CraftingBench(book);
    const cursor = new ItemCursor();
    bench.setSlot(0, { type: ItemType.Log, count: 1 });
    bench.cycle(); // toobifers
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
