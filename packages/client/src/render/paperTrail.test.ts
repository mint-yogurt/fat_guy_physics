import { describe, expect, it } from "vitest";
import { BufferAttribute, Group, Mesh, MeshBasicMaterial, BufferGeometry, CylinderGeometry, Scene } from "three/webgpu";

import { ROLLED_ITEMS } from "@fgp/shared/items/rolledItems";
import { ItemType } from "@fgp/shared/items/inventory";
import { SnowballField } from "@fgp/shared/items/snowball";

import { readPaperParts } from "./paperFlap.ts";
import { PaperTrails } from "./paperTrail.ts";

function paperParts() {
  const scene = new Group();
  const roll = new Mesh(new CylinderGeometry(0.0725, 0.0725, 0.07, 24).rotateZ(Math.PI / 2), new MeshBasicMaterial());
  roll.name = "roll";
  scene.add(roll);
  const flapGeometry = new BufferGeometry();
  flapGeometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-0.035, 0.1379, 0, 0.035, 0.1379, 0, -0.035, 0.075, 0, 0.035, 0.075, 0]), 3),
  );
  flapGeometry.setAttribute("uv", new BufferAttribute(new Float32Array([0.01, 0.44, 0.01, 0.03, 0.49, 0.44, 0.49, 0.03]), 2));
  flapGeometry.setIndex([2, 3, 1, 2, 1, 0]);
  const flap = new Mesh(flapGeometry, new MeshBasicMaterial());
  flap.name = "flap";
  scene.add(flap);
  return readPaperParts(scene)!;
}

const row = ROLLED_ITEMS.find((r) => r.item === ItemType.ToiletPaper)!;

function setup(support: (x: number, y: number, z: number) => number = () => 0) {
  const scene = new Scene();
  const trails = new PaperTrails(scene, paperParts(), support);
  const field = new SnowballField();
  const ball = field.spawn(0, 0.075, 0, 0, 0, 0, row.radius, row.material);
  return { scene, trails, field, ball };
}

/** The ribbon meshes in the scene that have anything to draw: their vertex heights and how many cells. */
function ribbons(scene: Scene): { cells: number; heights: number[] }[] {
  return scene.children
    .filter((child): child is Mesh => child instanceof Mesh && child.visible)
    .map((mesh) => {
      const range = mesh.geometry.drawRange.count;
      const position = mesh.geometry.getAttribute("position") as BufferAttribute;
      const cells = range / 6;
      const heights: number[] = [];
      for (let v = 0; v < cells * 4; v++) heights.push(position.getY(v));
      return { cells, heights };
    });
}

describe("paper trails", () => {
  it("lays paper on the ground behind a roll that is rolling along it", () => {
    const { scene, trails, field, ball } = setup();
    trails.sync(field, 1 / 60, 1);
    for (let i = 1; i <= 20; i++) {
      ball.x = i * 0.1;
      trails.sync(field, 1 / 60, 1);
    }
    const [trail] = ribbons(scene);
    // Two metres of paper in cells a flap long (about 6cm).
    expect(trail!.cells).toBeGreaterThan(25);
    expect(trail!.cells).toBeLessThan(40);
    for (const y of trail!.heights) expect(y).toBeCloseTo(0.02, 3);
  });

  it("leaves paper in the air behind a thrown roll, and it comes down on what is under it", () => {
    const floor = 0.5;
    const { scene, trails, field, ball } = setup(() => floor);
    ball.y = 3;
    trails.sync(field, 1 / 60, 1);
    for (let i = 1; i <= 10; i++) {
      ball.x = i * 0.3;
      trails.sync(field, 1 / 60, 1);
    }
    const [flying] = ribbons(scene);
    expect(flying!.cells).toBeGreaterThan(30);
    expect(Math.min(...flying!.heights)).toBeGreaterThan(2.5);
    for (let t = 0; t < 8; t += 1 / 60) trails.sync(field, 1 / 60, 1);
    const [landed] = ribbons(scene);
    for (const y of landed!.heights) expect(y).toBeCloseTo(floor + 0.02, 3);
  });

  it("follows a long roll into a second mesh, and lets old paper fade away", () => {
    const { scene, trails, field, ball } = setup();
    trails.sync(field, 1 / 60, 1);
    // Walked there in steps; a jump over the limit is not paper.
    for (let i = 1; i <= 300; i++) {
      ball.x = i * 0.1;
      trails.sync(field, 1 / 60, 1);
    }
    expect(ribbons(scene).length).toBeGreaterThan(1);
    // Taken up: no more paper, and what is down fades.
    field.balls.length = 0;
    for (let t = 0; t < 100; t += 0.5) trails.sync(field, 0.5, 1);
    expect(ribbons(scene)).toHaveLength(0);
  });
});
