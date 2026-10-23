import { describe, expect, it } from "vitest";

import { ItemType, itemTypeFromName } from "./inventory.ts";
import { ROLLED_ITEMS, TOILET_PAPER_RADIUS, itemOfBall, rolledItemOf, spawnRolled } from "./rolledItems.ts";
import { SnowballField } from "./snowball.ts";

describe("rolled items", () => {
  it("never share a material, so a ball on the ground can be told what it is", () => {
    expect(new Set(ROLLED_ITEMS.map((row) => row.material)).size).toBe(ROLLED_ITEMS.length);
  });

  it("includes toilet paper, which is lighter than a rock and rolls as a ball its own size", () => {
    const row = rolledItemOf(ItemType.ToiletPaper);
    expect(row?.radius).toBe(TOILET_PAPER_RADIUS);
    const rock = rolledItemOf(ItemType.Rock);
    expect(row!.material.density).toBeLessThan(rock!.material.density);
    expect(itemTypeFromName("toilet_paper")).toBe(ItemType.ToiletPaper);

    const field = new SnowballField();
    const ball = spawnRolled(field, row!, 0, 1, 0, 2, 0, 0);
    expect(itemOfBall(ball)).toBe(ItemType.ToiletPaper);
    expect(ball.radius).toBe(TOILET_PAPER_RADIUS);
  });

  it("sends a light roll off slower than a rock, and stops it sooner", () => {
    const paper = rolledItemOf(ItemType.ToiletPaper)!;
    const rock = rolledItemOf(ItemType.Rock)!;
    expect(paper.speedScale).toBeLessThan(1);
    expect(rock.speedScale ?? 1).toBe(1);
    expect(paper.material.drag).toBeGreaterThan(1.6);
  });
});
