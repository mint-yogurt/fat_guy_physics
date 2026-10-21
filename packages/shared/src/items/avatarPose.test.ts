import { describe, expect, it } from "vitest";

import {
  AvatarAction,
  HoldStyle,
  holdStyleOf,
  packAvatarPose,
  ThrowWatcher,
  unpackAvatarPose,
} from "./avatarPose.ts";
import { ItemType } from "./inventory.ts";

describe("AvatarPose", () => {
  it("survives packing into four bytes", () => {
    const pose = {
      held: ItemType.Log,
      action: AvatarAction.Lob,
      charge: 0.5,
      throwSeq: 255,
      thrown: AvatarAction.Bowl,
    };
    const back = unpackAvatarPose(packAvatarPose(pose));
    expect(back.held).toBe(ItemType.Log);
    expect(back.action).toBe(AvatarAction.Lob);
    expect(back.thrown).toBe(AvatarAction.Bowl);
    expect(back.charge).toBeCloseTo(0.5, 2);
    expect(back.throwSeq).toBe(255);
    expect(packAvatarPose(pose)).toBeGreaterThanOrEqual(0);
  });

  it("packs a shake, and every new item, and holds them all in the fist", () => {
    for (const held of [ItemType.MountainLightning, ItemType.Eggnog, ItemType.Coal, ItemType.Goo, ItemType.Metal, ItemType.Candy]) {
      const pose = { held, action: AvatarAction.Shake, charge: 0, throwSeq: 1, thrown: AvatarAction.Put };
      expect(unpackAvatarPose(packAvatarPose(pose))).toEqual(pose);
      expect(holdStyleOf(held)).toBe(HoldStyle.Ball);
    }
  });

  it("packs empty hands as no item", () => {
    const pose = {
      held: undefined,
      action: AvatarAction.Scoop,
      charge: 0,
      throwSeq: 3,
      thrown: AvatarAction.Charge,
    };
    expect(unpackAvatarPose(packAvatarPose(pose))).toEqual(pose);
  });

  it("gives every item a hold style", () => {
    expect(holdStyleOf(undefined)).toBe(HoldStyle.Empty);
    expect(holdStyleOf(ItemType.Stick)).toBe(HoldStyle.Blade);
    expect(holdStyleOf(ItemType.Log)).toBe(HoldStyle.Carry);
    expect(holdStyleOf(ItemType.Leaf)).toBe(HoldStyle.Pinch);
  });

  it("fires a throw once per counter change, including across a wrap", () => {
    const watcher = new ThrowWatcher();
    expect(watcher.check(255)).toBe(false);
    expect(watcher.check(255)).toBe(false);
    expect(watcher.check(0)).toBe(true);
    expect(watcher.check(0)).toBe(false);
  });
});
