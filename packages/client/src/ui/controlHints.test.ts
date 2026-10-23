import { describe, expect, it } from "vitest";

import { ItemType } from "@fgp/shared/items/inventory";

import { controlHintsFor } from "./controlHints.ts";

describe("controlHintsFor", () => {
  it("has hints for bare hands and every item that has a button action", () => {
    expect(controlHintsFor(undefined).map((h) => h.action)).toEqual(["scoop", "chup"]);
    for (const type of [
      ItemType.Stick,
      ItemType.Log,
      ItemType.Snowball,
      ItemType.Rock,
      ItemType.Trampoline,
      ItemType.Skateboard,
      ItemType.XmasLights,
    ]) {
      expect(controlHintsFor(type).length).toBeGreaterThan(0);
    }
    expect(controlHintsFor(ItemType.Leaf)).toEqual([]);
  });

  it("shows a rock's controls as a snowball's: it is rolled and put the same", () => {
    expect(controlHintsFor(ItemType.Rock)).toEqual(controlHintsFor(ItemType.Snowball));
  });

  it("shows an eggnog carton's controls as a rock's, and a can's and goo's as shake and throw", () => {
    expect(controlHintsFor(ItemType.Eggnog)).toEqual(controlHintsFor(ItemType.Rock));
    const shakeAndThrow = [
      { key: "LMB", action: "shake", hold: true },
      { key: "RMB", action: "throw", hold: true },
    ];
    expect(controlHintsFor(ItemType.MountainLightning)).toEqual(shakeAndThrow);
    expect(controlHintsFor(ItemType.Goo)).toEqual(shakeAndThrow);
  });

  it("shows nothing for coal, metal or candy: no button does anything with them", () => {
    for (const item of [ItemType.Coal, ItemType.Metal, ItemType.Candy]) expect(controlHintsFor(item)).toEqual([]);
  });

  it("shows how to place and turn everything placeable, and a log's tap-or-hold", () => {
    const turning = [
      { key: "Scroll", action: "turn" },
      { key: "R", action: "turn freely", hold: true },
    ];
    for (const item of [
      ItemType.Trampoline,
      ItemType.PresentSmall,
      ItemType.CandyBucket,
      ItemType.Ladder,
      ItemType.Toobifer,
      ItemType.Plywood,
      ItemType.Wheel,
    ]) {
      expect(controlHintsFor(item), String(item)).toEqual([{ key: "LMB", action: "place" }, ...turning]);
    }
    expect(controlHintsFor(ItemType.Log)).toEqual([
      { key: "LMB", action: "place" },
      { key: "LMB", action: "bowl", hold: true },
      { key: "RMB", action: "lob", hold: true },
      ...turning,
    ]);
  });

  it("shows the lights' extend and cancel buttons only when they apply", () => {
    const keys = (placing: boolean, canExtend: boolean): string[] =>
      controlHintsFor(ItemType.XmasLights, { placing, canExtend }).map((h) => `${h.key} ${h.action}`);
    expect(keys(false, false)).toEqual(["LMB tie first end"]);
    expect(keys(true, false)).toEqual(["LMB tie end", "E cancel"]);
    expect(keys(true, true)).toEqual(["LMB tie end", "RMB extend", "E cancel"]);
    expect(keys(false, true)).toEqual(["LMB tie first end"]);
  });
});
