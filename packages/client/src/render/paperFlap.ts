import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshLambertNodeMaterial,
  Quaternion,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { litByBulbs } from "./bulbLights.ts";
import { faceOutward } from "./meshOrientation.ts";
import { nearestify } from "./n64Texture.ts";

/**
 * The toilet paper's three parts, read out of its file, and the flap's physics in the hand.
 *
 * The file (tp.glb) has three named parts, found by exactly these names:
 *
 *  - the roll ("duct tape": the roll is still named after the mesh it was copied from; "roll" works too): the body. A cylinder; its axis is its shortest side.
 *  - the flap ("flap"): the loose end of the paper, hanging off the roll.
 *    A strip of one or more squares; one edge (the one nearest the roll) is where it is joined.
 *  - the hand mark ("hand goes here"): where the fist closes.
 *
 * Everywhere but the hand the flap stays exactly as it was modelled (slot, hotbar, the ground).
 * In the hand it is a hanging strip ({@link HeldPaper}); thrown or rolled it is copied behind the roll
 * as a trail (paperTrail.ts), which is why {@link PaperParts} keeps its size and its texture.
 *
 * Every geometry here is in the file's own frame ("paper frame"): the node transforms are baked in.
 */

/** Names the parts may have, in the order they are tried. Spaces and underscores are the same. */
const ROLL_NAMES = ["roll", "duct tape"];
const FLAP_NAMES = ["flap"];
const HAND_NAMES = ["hand goes here"];

/** How the flap's vertices hang from the strip it is bent along: where along it, and how far off it. */
export interface FlapShape {
  /** The joined edge's middle, paper frame. */
  readonly hinge: Vector3;
  /** Unit vector from the joined edge to the free one, paper frame. */
  readonly axis: Vector3;
  /** Unit vector across the strip (the roll's own axis, made square to `axis`). */
  readonly across: Vector3;
  /** Metres, joined edge to free edge. */
  readonly length: number;
  /** Metres, side to side. */
  readonly width: number;
  /**
   * Metres, the joined edge to the far edge of the first square. A flap of several squares is the same
   * sheet over and over; a trail lays one of these per cell.
   */
  readonly sheetLength: number;
  /** Per vertex: 0 at the joined edge, 1 at the free one. */
  readonly along: Float32Array;
  /** Per vertex: x, y, z of its offset from the strip's middle line, paper frame. */
  readonly offset: Float32Array;
  /** Texture coordinates at three corners of the strip: joined edge / one side, free edge / that side, joined edge / the other side. */
  readonly uv: { readonly a: [number, number]; readonly b: [number, number]; readonly c: [number, number] };
}

export interface PaperParts {
  readonly roll: BufferGeometry;
  /** Undefined if the file has no flap. */
  readonly flap: BufferGeometry | undefined;
  readonly shape: FlapShape | undefined;
  /** Lit like the props, glowing with the bulbs, drawn from both sides; shared by every part. */
  readonly material: Material;
  /** The roll's own axis (unit, paper frame), its middle, radius and half length along the axis. */
  readonly rollAxis: Vector3;
  readonly rollCentre: Vector3;
  readonly rollRadius: number;
  readonly rollHalfLength: number;
  /** Where the fist closes, paper frame. */
  readonly hand: Vector3;
}

const normalise = (name: string): string => name.toLowerCase().replaceAll("_", " ").replace(/\.\d+$/, "").trim();

function findNode(scene: Object3D, names: readonly string[]): Object3D | undefined {
  for (const wanted of names) {
    let found: Object3D | undefined;
    scene.traverse((object) => {
      if (found === undefined && normalise(object.name) === wanted) found = object;
    });
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Every mesh at or under `node`, merged into one geometry in the scene's frame. */
function bake(node: Object3D, scene: Object3D): BufferGeometry | undefined {
  scene.updateMatrixWorld(true);
  const toScene = new Matrix4().copy(scene.matrixWorld).invert();
  const parts: BufferGeometry[] = [];
  node.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = (object.geometry as BufferGeometry).clone();
    geometry.applyMatrix4(new Matrix4().multiplyMatrices(toScene, object.matrixWorld));
    parts.push(geometry);
  });
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : mergeGeometries(parts, false) ?? parts[0];
}

function positionsOf(geometry: BufferGeometry): Vector3[] {
  const position = geometry.getAttribute("position") as BufferAttribute;
  const out: Vector3[] = [];
  for (let i = 0; i < position.count; i++) out.push(new Vector3().fromBufferAttribute(position, i));
  return out;
}

/** The flap's hinge, axis and per-vertex place along it, worked out from where it sits against the roll. */
function readFlap(
  flap: BufferGeometry,
  rollAxis: Vector3,
  rollCentre: Vector3,
): FlapShape | undefined {
  const points = positionsOf(flap);
  if (points.length < 3) return undefined;
  const distance = points.map((point) => {
    const rel = point.clone().sub(rollCentre);
    return rel.addScaledVector(rollAxis, -rel.dot(rollAxis)).length();
  });
  const nearest = Math.min(...distance);
  const farthest = Math.max(...distance);
  if (farthest - nearest < 1e-5) return undefined;
  const cut = 0.25 * (farthest - nearest);
  const hinge = new Vector3();
  const free = new Vector3();
  let hingeCount = 0;
  let freeCount = 0;
  points.forEach((point, i) => {
    const d = distance[i] ?? 0;
    if (d <= nearest + cut) {
      hinge.add(point);
      hingeCount++;
    } else if (d >= farthest - cut) {
      free.add(point);
      freeCount++;
    }
  });
  hinge.divideScalar(Math.max(1, hingeCount));
  free.divideScalar(Math.max(1, freeCount));
  // Across the strip is the roll's axis (the paper comes off the roll's whole width); it runs from the
  // joined edge to the free one, squared to that. A free edge shifted sideways stays an offset.
  const across = rollAxis.clone().normalize();
  const axis = free.clone().sub(hinge);
  axis.addScaledVector(across, -axis.dot(across));
  const length = axis.length();
  if (length < 1e-5) return undefined;
  axis.divideScalar(length);

  const along = new Float32Array(points.length);
  const offset = new Float32Array(points.length * 3);
  const sideOf = new Float32Array(points.length);
  const rel = new Vector3();
  points.forEach((point, i) => {
    rel.copy(point).sub(hinge);
    const t = rel.dot(axis) / length;
    along[i] = t;
    rel.addScaledVector(axis, -t * length);
    offset[i * 3] = rel.x;
    offset[i * 3 + 1] = rel.y;
    offset[i * 3 + 2] = rel.z;
    sideOf[i] = rel.dot(across);
  });

  // The first square: every vertex of a triangle that touches the joined edge. (Squares are separate
  // quads, each with the same texture, so the corners are read off this one alone.)
  const joined = (i: number): boolean => (along[i] ?? 0) < 0.02;
  const first = new Set<number>();
  const index = flap.getIndex();
  if (index !== null) {
    for (let k = 0; k + 2 < index.count; k += 3) {
      const a = index.getX(k);
      const b = index.getX(k + 1);
      const c = index.getX(k + 2);
      if (joined(a) || joined(b) || joined(c)) {
        first.add(a);
        first.add(b);
        first.add(c);
      }
    }
  }
  if (first.size < 3) points.forEach((_, i) => first.add(i));

  let low = Infinity;
  let high = -Infinity;
  let far = 0;
  for (const i of first) {
    low = Math.min(low, sideOf[i] ?? 0);
    high = Math.max(high, sideOf[i] ?? 0);
    far = Math.max(far, along[i] ?? 0);
  }
  const edge = new Vector3();
  let edgeCount = 0;
  for (const i of first) {
    if ((along[i] ?? 0) < far - 0.02) continue;
    edge.add(points[i] as Vector3);
    edgeCount++;
  }
  const sheetLength = edgeCount === 0 ? length : edge.divideScalar(edgeCount).sub(hinge).length();

  // Texture at the first square's corners: the vertex nearest each, in (along, across) space.
  const uvAttribute = flap.getAttribute("uv") as BufferAttribute | undefined;
  const corner = (wantAlong: number, wantSide: number): [number, number] => {
    let best = -1;
    let bestError = Infinity;
    for (const i of first) {
      const error = Math.hypot(((along[i] ?? 0) - wantAlong) * length, (sideOf[i] ?? 0) - wantSide);
      if (error < bestError) {
        bestError = error;
        best = i;
      }
    }
    return uvAttribute === undefined || best < 0 ? [0, 0] : [uvAttribute.getX(best), uvAttribute.getY(best)];
  };

  return {
    hinge,
    axis,
    across,
    length,
    width: Math.max(high - low, 1e-3),
    sheetLength,
    along,
    offset,
    uv: { a: corner(0, low), b: corner(far, low), c: corner(0, high) },
  };
}

/** Reads the toilet paper out of its loaded file; undefined if the file has no roll. */
export function readPaperParts(scene: Object3D): PaperParts | undefined {
  const rollNode = findNode(scene, ROLL_NAMES);
  if (rollNode === undefined) return undefined;
  const roll = bake(rollNode, scene);
  if (roll === undefined) return undefined;
  faceOutward(roll);

  // Its axis is the short side of its bounds; its radius is half the longer of the other two.
  roll.computeBoundingBox();
  const box = roll.boundingBox;
  if (box === null) return undefined;
  const size = box.getSize(new Vector3());
  const rollCentre = box.getCenter(new Vector3());
  const sides = [size.x, size.y, size.z];
  const shortest = sides.indexOf(Math.min(...sides));
  const rollAxis = new Vector3(shortest === 0 ? 1 : 0, shortest === 1 ? 1 : 0, shortest === 2 ? 1 : 0);
  const rollHalfLength = (sides[shortest] ?? 0) / 2;
  const rollRadius = Math.max(...sides.filter((_, i) => i !== shortest)) / 2;

  const flapNode = findNode(scene, FLAP_NAMES);
  const flap = flapNode === undefined ? undefined : bake(flapNode, scene);
  const shape = flap === undefined ? undefined : readFlap(flap, rollAxis, rollCentre);

  // The file's own material only supplies the texture; the look is ours (lit, bulb-lit, both sides).
  const found: { map: Texture | null } = { map: null };
  scene.traverse((object) => {
    if (found.map !== null || !(object instanceof Mesh)) return;
    const source = Array.isArray(object.material) ? object.material[0] : object.material;
    found.map = (source as (Material & { map?: Texture | null }) | undefined)?.map ?? null;
  });
  if (found.map !== null) nearestify(found.map);
  const material = litByBulbs(new MeshLambertNodeMaterial({ map: found.map as never, side: DoubleSide, alphaTest: 0.5 }));

  const handNode = findNode(scene, HAND_NAMES);
  scene.updateMatrixWorld(true);
  const hand = handNode === undefined ? rollCentre.clone() : handNode.getWorldPosition(new Vector3());

  return { roll, flap, shape, material, rollAxis, rollCentre, rollRadius, rollHalfLength, hand };
}

// --- in the hand ----------------------------------------------------------------------------

/** Points along the flap that are simulated, joined edge not counted. More bends it more smoothly. */
const FLAP_LINKS = 4;
/** Paper falls slowly, m/s^2 (a stone: 9.8). */
const FLAP_GRAVITY = 6.5;
/** Fraction of its speed the flap loses to the air each second (e^-x). */
const FLAP_AIR_DRAG = 3.2;
/** How hard the flap springs back toward the way it was modelled, m/s^2 per metre it is out of place. */
const FLAP_STIFFNESS = 22;
/** Always a little restless: m/s^2 of wobble, and its rate in radians per second. */
const FLAP_FLUTTER = 1.6;
const FLAP_FLUTTER_RATE = 11;
/** The longest step simulated, seconds; a longer pause than FLAP_RESET_SECONDS starts it again from rest. */
const FLAP_MAX_STEP = 1 / 30;
const FLAP_RESET_SECONDS = 0.25;
const FLAP_ITERATIONS = 4;
/** How much of the way to "straight on from the link before" each point is pulled, per pass: paper does not fold like a chain. */
const FLAP_BEND_STIFFNESS = 0.07;
/** How far outside the roll's surface the paper is kept, in the roll's own units. */
const FLAP_ROLL_MARGIN = 0.003;

const scratchMatrix = new Matrix4();
const scratchInverse = new Matrix4();
const point = new Vector3();
/** Which way the flap flutters: off its own face, in scene space. */
const faceDirection = new Vector3();
const local = new Vector3();
const dir = new Vector3();
const rotated = new Vector3();
const noTurn = new Quaternion();

/**
 * The toilet paper in a hand: the roll as modelled, and the flap hanging off it as a strip of cloth that
 * swings, trails and flaps with the hand. The simulation runs in the scene's own space, so a hand that
 * moves leaves the paper behind, and gravity pulls it down whichever way the roll is turned.
 *
 * `object` is what gets parented to the holder; its origin is the middle of the roll (the hold point puts that against the hand).
 */
export class HeldPaper {
  readonly object = new Group();
  private readonly inner = new Group();
  private readonly flapGeometry: BufferGeometry | undefined;
  private readonly restNormal: Float32Array;
  /** Verlet points in scene space: where they are and where they were. Index 0 is the joined edge. */
  private readonly now: Vector3[] = [];
  private readonly before: Vector3[] = [];
  private lastTime = -Infinity;
  private phase = Math.random() * 6.28;

  constructor(private readonly parts: PaperParts) {
    // The roll's middle is the holder's origin, so a hold point can put the roll itself against the hand.
    this.inner.position.copy(parts.rollCentre).negate();
    this.object.add(this.inner);
    this.inner.add(new Mesh(parts.roll, parts.material));
    this.restNormal = new Float32Array(0);
    if (parts.flap !== undefined && parts.shape !== undefined) {
      // Its own copy of the geometry: the flap bends per hand, the roll's is shared.
      this.flapGeometry = parts.flap.clone();
      const normal = this.flapGeometry.getAttribute("normal") as BufferAttribute | undefined;
      this.restNormal = normal === undefined ? new Float32Array(0) : Float32Array.from(normal.array);
      const mesh = new Mesh(this.flapGeometry, parts.material);
      mesh.frustumCulled = false;
      this.inner.add(mesh);
      for (let i = 0; i <= FLAP_LINKS; i++) {
        this.now.push(new Vector3());
        this.before.push(new Vector3());
      }
    }
  }

  /**
   * Moves the flap on to the frame being drawn. Call after the holder has been posed. `seconds` is any
   * steady clock; the step is the time since the last call.
   */
  update(seconds: number): void {
    const shape = this.parts.shape;
    const geometry = this.flapGeometry;
    if (shape === undefined || geometry === undefined) return;
    const step = seconds - this.lastTime;
    if (step < 1e-4) return;
    this.inner.updateWorldMatrix(true, false);
    scratchMatrix.copy(this.inner.matrixWorld);
    scratchInverse.copy(scratchMatrix).invert();
    // Uniform scale, as the holders are.
    const scale = Math.cbrt(Math.abs(scratchMatrix.determinant()));
    const link = (shape.length / FLAP_LINKS) * scale;

    if (step > FLAP_RESET_SECONDS) this.reset(shape);
    else this.simulate(Math.min(step, FLAP_MAX_STEP), shape, link, scale);
    this.lastTime = seconds;
    this.bend(shape, geometry);
  }

  /** Back to hanging as modelled, with no speed. */
  private reset(shape: FlapShape): void {
    for (let i = 0; i <= FLAP_LINKS; i++) {
      this.restPoint(shape, i, this.now[i] as Vector3);
      (this.before[i] as Vector3).copy(this.now[i] as Vector3);
    }
  }

  /** Where point `i` is when the flap is as modelled, in scene space. */
  private restPoint(shape: FlapShape, i: number, out: Vector3): Vector3 {
    return out.copy(shape.hinge).addScaledVector(shape.axis, (shape.length * i) / FLAP_LINKS).applyMatrix4(scratchMatrix);
  }

  private simulate(dt: number, shape: FlapShape, link: number, scale: number): void {
    this.phase += dt * FLAP_FLUTTER_RATE;
    const drag = Math.exp(-FLAP_AIR_DRAG * dt);
    const first = this.now[0] as Vector3;
    const firstBefore = this.before[0] as Vector3;
    // The joined edge goes with the roll.
    firstBefore.copy(first);
    this.restPoint(shape, 0, first);
    // The air moves the strip off its face, not along its width (which would only twist it).
    faceDirection.crossVectors(shape.axis, shape.across).transformDirection(scratchMatrix);

    for (let i = 1; i <= FLAP_LINKS; i++) {
      const p = this.now[i] as Vector3;
      const q = this.before[i] as Vector3;
      const vx = (p.x - q.x) * drag;
      const vy = (p.y - q.y) * drag;
      const vz = (p.z - q.z) * drag;
      q.copy(p);
      this.restPoint(shape, i, point);
      const flutter = FLAP_FLUTTER * Math.sin(this.phase + i * 1.9);
      // Pulled toward its modelled place with strength that fades toward the joined edge's side: the
      // free end swings freest.
      const pull = FLAP_STIFFNESS * (i / FLAP_LINKS);
      p.x += vx + (point.x - p.x) * pull * dt * dt + faceDirection.x * flutter * dt * dt;
      p.y += vy + (point.y - p.y) * pull * dt * dt - FLAP_GRAVITY * dt * dt + faceDirection.y * flutter * dt * dt;
      p.z += vz + (point.z - p.z) * pull * dt * dt + faceDirection.z * flutter * dt * dt;
    }

    for (let iteration = 0; iteration < FLAP_ITERATIONS; iteration++) {
      for (let i = 1; i <= FLAP_LINKS; i++) {
        const a = this.now[i - 1] as Vector3;
        const b = this.now[i] as Vector3;
        dir.copy(b).sub(a);
        const length = dir.length();
        if (length < 1e-9) continue;
        const error = (length - link) / length;
        // The joined edge cannot move; every other point shares the correction.
        if (i === 1) {
          b.addScaledVector(dir, -error);
        } else {
          a.addScaledVector(dir, error * 0.5);
          b.addScaledVector(dir, -error * 0.5);
        }
      }
      // Paper resists folding: each point is pulled toward carrying straight on from the two before it.
      for (let i = 2; i <= FLAP_LINKS; i++) {
        const a = this.now[i - 2] as Vector3;
        const b = this.now[i - 1] as Vector3;
        const c = this.now[i] as Vector3;
        dir.copy(b).sub(a);
        if (dir.lengthSq() < 1e-12) continue;
        point.copy(b).addScaledVector(dir.normalize(), link);
        c.lerp(point, FLAP_BEND_STIFFNESS);
      }
      this.pushOutOfRoll(scale);
    }
  }

  /** Keeps the strip outside the roll: the roll is a cylinder, and the paper is on it, not in it. */
  private pushOutOfRoll(scale: number): void {
    const { rollAxis, rollCentre, rollRadius, rollHalfLength } = this.parts;
    for (let i = 1; i <= FLAP_LINKS; i++) {
      const p = this.now[i] as Vector3;
      local.copy(p).applyMatrix4(scratchInverse).sub(rollCentre);
      const along = local.dot(rollAxis);
      rotated.copy(local).addScaledVector(rollAxis, -along);
      const radial = rotated.length();
      const reach = rollRadius + FLAP_ROLL_MARGIN / Math.max(scale, 1e-6);
      const halfLength = rollHalfLength + FLAP_ROLL_MARGIN / Math.max(scale, 1e-6);
      if (radial >= reach || Math.abs(along) >= halfLength) continue;
      // Out whichever way is nearest: round the rim or off an end.
      if (reach - radial < halfLength - Math.abs(along) && radial > 1e-9) {
        local.copy(rotated).multiplyScalar(reach / radial).addScaledVector(rollAxis, along);
      } else {
        local.copy(rotated).addScaledVector(rollAxis, Math.sign(along || 1) * halfLength);
      }
      p.copy(local.add(rollCentre)).applyMatrix4(scratchMatrix);
    }
  }

  /** Writes the strip's vertices along the bent line. */
  private bend(shape: FlapShape, geometry: BufferGeometry): void {
    const position = geometry.getAttribute("position") as BufferAttribute;
    const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
    // The line in the roll's own frame, and each piece's turn from the modelled direction.
    const line: Vector3[] = [];
    for (let i = 0; i <= FLAP_LINKS; i++) {
      line.push(new Vector3().copy(this.now[i] as Vector3).applyMatrix4(scratchInverse));
    }
    const turns: Quaternion[] = [];
    for (let i = 0; i < FLAP_LINKS; i++) {
      dir.copy(line[i + 1] as Vector3).sub(line[i] as Vector3);
      if (dir.lengthSq() < 1e-12) dir.copy(shape.axis);
      turns.push(new Quaternion().setFromUnitVectors(shape.axis, dir.normalize()));
    }
    for (let v = 0; v < position.count; v++) {
      const t = Math.min(1, Math.max(0, shape.along[v] ?? 0)) * FLAP_LINKS;
      const k = Math.min(FLAP_LINKS - 1, Math.floor(t));
      const f = t - k;
      const turn = turns[k] ?? noTurn;
      const a = line[k] as Vector3;
      const b = line[k + 1] as Vector3;
      rotated.set(shape.offset[v * 3] ?? 0, shape.offset[v * 3 + 1] ?? 0, shape.offset[v * 3 + 2] ?? 0).applyQuaternion(turn);
      position.setXYZ(v, a.x + (b.x - a.x) * f + rotated.x, a.y + (b.y - a.y) * f + rotated.y, a.z + (b.z - a.z) * f + rotated.z);
      if (normal !== undefined && this.restNormal.length > 0) {
        rotated.set(this.restNormal[v * 3] ?? 0, this.restNormal[v * 3 + 1] ?? 0, this.restNormal[v * 3 + 2] ?? 0).applyQuaternion(turn);
        normal.setXYZ(v, rotated.x, rotated.y, rotated.z);
      }
    }
    position.needsUpdate = true;
    if (normal !== undefined) normal.needsUpdate = true;
  }
}
