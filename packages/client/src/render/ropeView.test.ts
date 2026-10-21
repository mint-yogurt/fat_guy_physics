import { Color, Group, Object3D, Vector3 } from "three/webgpu";
import { describe, expect, it } from "vitest";

import { planRope, Rope, XMAS_LIGHTS } from "@fgp/shared/items/rope";

import { buildCoil, RopeChain, type RopeParts } from "./ropeView.ts";

/** Three sections whose bulbs point 120 degrees apart, like xmaslights.glb's. */
const parts: RopeParts = {
  units: [
    new Vector3(0, -1, 0),
    new Vector3(-0.866, 0.5, 0),
    new Vector3(0.866, 0.5, 0),
  ].map((bulbDirection) => ({
    wire: new Object3D(),
    bulb: new Object3D(),
    bulbDirection,
    glowCenter: bulbDirection.clone().multiplyScalar(0.02),
    lightColor: new Color(1, 0, 0),
  })),
};

const tieAt = (x: number, y: number, z: number) => ({ x, y, z });

/** Where a segment's bulb points in the world. */
function bulbWorld(chain: RopeChain, index: number): Vector3 {
  const segment = chain.root.children[index];
  if (!(segment instanceof Group)) throw new Error("no segment");
  chain.root.updateMatrixWorld(true);
  const unit = parts.units[index % 3];
  return (unit?.bulbDirection.clone() ?? new Vector3()).applyQuaternion(segment.quaternion);
}

describe("RopeChain", () => {
  it("lays one piece per segment between the rope's nodes, stretched to fit", () => {
    const rope = new Rope(1, XMAS_LIGHTS, tieAt(0, 2, 0), tieAt(3, 2, 0), planRope(XMAS_LIGHTS, 3).length);
    const chain = new RopeChain(parts, XMAS_LIGHTS.segments);
    chain.follow(rope);
    expect(chain.root.children).toHaveLength(9);
    const first = chain.root.children[0];
    expect(first?.position.x).toBeCloseTo(0.5 * (3 / 9), 3);
    const wire = first?.children[0];
    // 1/3m between nodes, drawn from a 0.1m-long piece.
    expect(wire?.scale.z).toBeCloseTo(3 / 9 / 0.1, 3);
  });

  it("hangs every bulb down, whichever way its section was modelled", () => {
    const rope = new Rope(1, XMAS_LIGHTS, tieAt(0, 2, 0), tieAt(3, 2.5, 1), planRope(XMAS_LIGHTS, 3.2).length);
    const chain = new RopeChain(parts, XMAS_LIGHTS.segments);
    for (let i = 0; i < 400; i++) rope.step(1 / 120, { isSolid: () => false });
    chain.follow(rope);
    for (let i = 0; i < 9; i++) {
      const bulb = bulbWorld(chain, i);
      expect(bulb.length()).toBeCloseTo(1, 3);
      expect(bulb.y).toBeLessThan(-0.8);
    }
  });

  it("keeps its pieces finite when the rope is straight up and down", () => {
    const rope = new Rope(1, XMAS_LIGHTS, tieAt(0, 4, 0), tieAt(0, 1, 0), planRope(XMAS_LIGHTS, 3).length);
    const chain = new RopeChain(parts, XMAS_LIGHTS.segments);
    chain.follow(rope);
    chain.root.updateMatrixWorld(true);
    for (const piece of chain.root.children) {
      expect(Number.isFinite(piece.quaternion.x + piece.quaternion.w + piece.position.y)).toBe(true);
    }
  });

  it("coils up flat with its bulbs facing out", () => {
    const coil = buildCoil(parts);
    const chain = coil.children[0];
    expect(chain?.children.length).toBe(24);
    const piece = chain?.children[0];
    expect(piece?.position.length()).toBeGreaterThan(0.05);
    expect(piece?.position.length()).toBeLessThan(0.15);
  });
});
