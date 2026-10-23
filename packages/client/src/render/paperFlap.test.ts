import { describe, expect, it } from "vitest";
import { BufferAttribute, BufferGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three/webgpu";

import { HeldPaper, readPaperParts } from "./paperFlap.ts";

/**
 * A stand-in for tp.glb as authored: a roll 14.5cm across and 7cm long lying on its side (axis along X),
 * a one-square flap standing up off its top, and the hand mark under it.
 */
function fakeFile(): Group {
  const scene = new Group();
  const rollGeometry = new CylinderGeometry(0.0725, 0.0725, 0.07, 24).rotateZ(Math.PI / 2).translate(0, 0.00225, 0);
  const roll = new Mesh(rollGeometry, new MeshBasicMaterial());
  roll.name = "roll";
  scene.add(roll);

  const flapGeometry = new BufferGeometry();
  flapGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-0.035, 0.1379, -0.0116, 0.035, 0.1379, -0.0116, -0.035, 0.075, 0, 0.035, 0.075, 0]), 3),
  );
  flapGeometry.setAttribute("normal", new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  flapGeometry.setAttribute("uv", new BufferAttribute(new Float32Array([0.01, 0.44, 0.01, 0.03, 0.49, 0.44, 0.49, 0.03]), 2));
  flapGeometry.setIndex([2, 3, 1, 2, 1, 0]);
  const flap = new Mesh(flapGeometry, new MeshBasicMaterial());
  flap.name = "flap";
  scene.add(flap);

  const hand = new Group();
  hand.name = "hand_goes_here";
  hand.position.set(0, -0.07, 0);
  scene.add(hand);
  return scene;
}

function flapPoints(paper: HeldPaper): Vector3[] {
  const inner = paper.object.children[0];
  const flap = inner?.children[1] as Mesh;
  const position = flap.geometry.getAttribute("position") as BufferAttribute;
  const out: Vector3[] = [];
  for (let i = 0; i < position.count; i++) out.push(new Vector3().fromBufferAttribute(position, i));
  return out;
}

/** Runs the paper at 60fps for `seconds`, calling `move` with the time before each frame. */
function run(paper: HeldPaper, seconds: number, move: (t: number) => void = () => {}): void {
  for (let frame = 0; frame <= seconds * 60; frame++) {
    const t = frame / 60;
    move(t);
    paper.update(t);
  }
}

describe("reading the toilet paper", () => {
  const parts = readPaperParts(fakeFile())!;

  it("finds the roll's axis, size and hand mark by name", () => {
    expect(parts).toBeDefined();
    expect(Math.abs(parts.rollAxis.x)).toBe(1);
    expect(parts.rollRadius).toBeCloseTo(0.0725, 3);
    expect(parts.rollHalfLength).toBeCloseTo(0.035, 3);
    expect(parts.hand.y).toBeCloseTo(-0.07, 5);
  });

  it("works out which edge of the flap is joined, and how big the strip is", () => {
    const shape = parts.shape!;
    expect(shape.axis.y).toBeGreaterThan(0.9);
    expect(shape.hinge.y).toBeCloseTo(0.075, 3);
    expect(shape.length).toBeCloseTo(0.0636, 2);
    expect(shape.width).toBeCloseTo(0.07, 3);
    expect(Math.min(...shape.along)).toBeCloseTo(0, 5);
    expect(Math.max(...shape.along)).toBeCloseTo(1, 5);
  });

  it("is happy with a file that has no flap", () => {
    const scene = fakeFile();
    scene.remove(scene.getObjectByName("flap")!);
    const bare = readPaperParts(scene)!;
    expect(bare.flap).toBeUndefined();
    expect(bare.shape).toBeUndefined();
    const paper = new HeldPaper(bare);
    expect(() => paper.update(1)).not.toThrow();
  });
});

describe("the flap in the hand", () => {
  it("starts out as it was modelled", () => {
    const parts = readPaperParts(fakeFile())!;
    const paper = new HeldPaper(parts);
    paper.update(1);
    const modelled = parts.flap!.getAttribute("position") as BufferAttribute;
    flapPoints(paper).forEach((point, i) => {
      expect(point.distanceTo(new Vector3().fromBufferAttribute(modelled, i))).toBeLessThan(1e-5);
    });
  });

  it("droops with gravity, stays out of the roll, and keeps its length", () => {
    const parts = readPaperParts(fakeFile())!;
    const paper = new HeldPaper(parts);
    run(paper, 2);
    const points = flapPoints(paper);
    const modelled = parts.flap!.getAttribute("position") as BufferAttribute;
    const modelledTop = Math.max(...points.map((_, i) => modelled.getY(i)));
    expect(Math.max(...points.map((p) => p.y))).toBeLessThan(modelledTop - 0.01);
    for (const p of points) {
      const radial = Math.hypot(p.y - parts.rollCentre.y, p.z - parts.rollCentre.z);
      const inside = radial < parts.rollRadius - 0.004 && Math.abs(p.x) < parts.rollHalfLength;
      expect(inside).toBe(false);
    }
    // The joined edge has not moved: it is the roll's.
    const joined = points.filter((_, i) => (parts.shape!.along[i] ?? 0) < 0.5);
    for (const p of joined) expect(p.y).toBeCloseTo(0.075, 2);
  });

  it("trails behind a hand that moves", () => {
    const parts = readPaperParts(fakeFile())!;
    const paper = new HeldPaper(parts);
    // Off along the way the strip is leaning (+Z), at a run; the air drags it back toward -Z.
    run(paper, 0.5, (t) => {
      paper.object.position.z = 5 * t;
    });
    const free = flapPoints(paper).filter((_, i) => (parts.shape!.along[i] ?? 0) > 0.5);
    for (const p of free) expect(p.z).toBeLessThan(-0.0116 - 0.01);
  });

  it("starts again from rest after a long pause rather than snapping across the gap", () => {
    const parts = readPaperParts(fakeFile())!;
    const paper = new HeldPaper(parts);
    run(paper, 1);
    paper.object.position.set(40, 3, -7);
    paper.update(50);
    const modelled = parts.flap!.getAttribute("position") as BufferAttribute;
    flapPoints(paper).forEach((point, i) => {
      expect(point.distanceTo(new Vector3().fromBufferAttribute(modelled, i))).toBeLessThan(1e-4);
    });
  });
});

/** tp.glb as authored: the numbers from the file itself (nodes with a quarter turn about Y and a stretch, two squares of flap). */
function tpFile(): Group {
  const scene = new Group();
  const place = (mesh: Mesh): void => {
    mesh.rotation.y = Math.PI / 2;
    mesh.scale.set(1.100846, 1.100846, 1.80038);
    mesh.position.set(0, 0.002353, 0);
  };
  const roll = new Mesh(new CylinderGeometry(0.0739, 0.0739, 0.07, 24).rotateX(Math.PI / 2).translate(0, 0.00225, 0), new MeshBasicMaterial());
  roll.name = "duct_tape";
  place(roll);
  scene.add(roll);

  const g = new BufferGeometry();
  const p = [
    [0.0822, 0.0971, -0.035], [0.0822, 0.0971, -0.035], [0.0822, 0.0971, 0.035], [0.0822, 0.0971, 0.035],
    [0, 0.075, -0.035], [0, 0.075, 0.035], [0.1225, 0.1628, -0.0416], [0.1225, 0.1628, 0.0284],
  ];
  const uv = [[0.9932, 0.4048], [0.9932, 0.0632], [0.5176, 0.4048], [0.5176, 0.0632], [0.9932, 0.0632], [0.5176, 0.0632], [0.9932, 0.4048], [0.5176, 0.4048]];
  g.setAttribute("position", new BufferAttribute(new Float32Array(p.flat()), 3));
  g.setAttribute("uv", new BufferAttribute(new Float32Array(uv.flat()), 2));
  g.setIndex([4, 5, 2, 4, 2, 0, 1, 3, 7, 1, 7, 6]);
  const flap = new Mesh(g, new MeshBasicMaterial());
  flap.name = "flap";
  place(flap);
  scene.add(flap);

  const hand = new Group();
  hand.name = "hand_goes_here";
  hand.position.set(0, -0.0747, 0);
  scene.add(hand);
  return scene;
}

describe("tp.glb as authored", () => {
  it("reads the roll, the two-square flap and the hand mark", () => {
    const parts = readPaperParts(tpFile())!;
    const shape = parts.shape!;
    expect(Math.abs(parts.rollAxis.x)).toBe(1);
    // Hinge on top of the roll in the middle; the flap runs back (-Z) and up.
    expect(shape.hinge.y).toBeCloseTo(0.0848, 3);
    expect(shape.axis.z).toBeLessThan(-0.7);
    expect(shape.axis.y).toBeGreaterThan(0.4);
    expect(shape.length).toBeCloseTo(0.166, 2);
    // One square is the joined edge to the middle row: about 9.4cm long and 12.6cm wide.
    expect(shape.sheetLength).toBeCloseTo(0.0936, 3);
    expect(shape.width).toBeCloseTo(0.126, 3);
    // Three rows of vertices: the joined edge, the middle, the free edge.
    const rows = new Set(Array.from(shape.along, (t) => Math.round(t * 20)));
    expect(rows.size).toBe(3);
    // The first square's texture: along its length is V, from .0632 to .4048.
    expect(shape.uv.a[1]).toBeCloseTo(0.0632, 4);
    expect(shape.uv.b[1]).toBeCloseTo(0.4048, 4);
    expect(shape.uv.c[1]).toBeCloseTo(0.0632, 4);
    expect(shape.uv.a[0]).not.toBeCloseTo(shape.uv.c[0], 2);
    expect(parts.hand.y).toBeCloseTo(-0.0747, 4);
  });

  it("starts as modelled, and never ends up inside the roll however it settles", () => {
    for (let trial = 0; trial < 12; trial++) {
      const parts = readPaperParts(tpFile())!;
      const paper = new HeldPaper(parts);
      paper.update(1);
      const modelled = parts.flap!.getAttribute("position") as BufferAttribute;
      flapPoints(paper).forEach((point, i) => {
        expect(point.distanceTo(new Vector3().fromBufferAttribute(modelled, i))).toBeLessThan(1e-4);
      });
      run(paper, 3);
      for (const p of flapPoints(paper)) {
        const radial = Math.hypot(p.y - parts.rollCentre.y, p.z - parts.rollCentre.z);
        expect(radial < parts.rollRadius - 0.006 && Math.abs(p.x) < parts.rollHalfLength - 0.001).toBe(false);
      }
    }
  });
});
