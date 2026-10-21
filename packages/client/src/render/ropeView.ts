import {
  AdditiveBlending,
  Box3,
  Color,
  DataTexture,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Material,
  type Object3D,
  type Scene,
} from "three/webgpu";

import type { Rope, RopeField } from "@fgp/shared/items/rope";

import { bulbLights } from "./bulbLights.ts";

/**
 * The xmas lights, drawn. xmaslights.glb is three sections along +Z, each a
 * piece of wire 0.1m long with a bulb in its middle: green, red, blue, and
 * each bulb hangs a third of a turn round from the last. A string of lights
 * is a row of those, one per segment of the simulated rope, each stretched
 * to the segment's length and turned about its own axis so the bulb hangs
 * down. The sections are straight and the string bends where they meet.
 *
 * Coiled up (as an item on the ground, in the hotbar, in a hand) the same
 * pieces are laid along a spiral instead.
 *
 * The bulbs are lit: drawn unlit in a bright colour with a soft additive
 * halo round each (the Rare way, no bloom needed), and the bulbs of tied
 * strings light what is round them through bulbLights.ts.
 */

/** How long one section is as authored, metres. */
const AUTHORED_SECTION = 0.1;
/** The lights are drawn this much thicker than modelled, so they read at a distance. */
const THICKNESS = 1.6;

const SECTION_NAMES = ["green", "red", "blue"] as const;

/** Each bulb's own colour as drawn: lighter than its light, so it reads hot. */
const BULB_COLORS = { green: 0x7dff8a, red: 0xff6a5a, blue: 0x7a9cff } as const;
/** The colour each bulb throws onto things round it. */
const LIGHT_COLORS = { green: 0x30ff40, red: 0xff2a18, blue: 0x3a5cff } as const;
/** Halo across, metres, round each bulb. */
const HALO_SIZE = 0.32;
/** How strong the halo is at its middle (additive). */
const HALO_STRENGTH = 0.75;

/** One colour's pieces, with the section's centre on the origin and its length along +Z. */
export interface RopeUnit {
  readonly wire: Object3D;
  readonly bulb: Object3D;
  /** Unit vector, at right angles to the wire, from the wire to its bulb. */
  readonly bulbDirection: Vector3;
  /** The middle of the glass, in the section's frame. */
  readonly glowCenter: Vector3;
  /** The light it throws. */
  readonly lightColor: Color;
}

export interface RopeParts {
  readonly units: readonly RopeUnit[];
}

/** A soft round spot, white in the middle and gone at the edge. */
function haloTexture(): DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const t = Math.max(0, 1 - Math.hypot(dx, dy) * 2);
      const v = Math.round(255 * t * t);
      const o = (y * size + x) * 4;
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function haloMaterial(map: DataTexture, color: number): SpriteMaterial {
  return new SpriteMaterial({
    map,
    color: new Color(color).multiplyScalar(HALO_STRENGTH),
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    fog: false,
  });
}

/** Picks the three sections out of the loaded file. */
export function readRopeParts(scene: Object3D): RopeParts {
  const halo = haloTexture();
  const units = SECTION_NAMES.map((name): RopeUnit => {
    const wireNode = scene.getObjectByName(`wire_${name}`);
    const bulbNode = scene.getObjectByName(`bulb_${name}`);
    if (wireNode === undefined || bulbNode === undefined) {
      throw new Error(`xmaslights.glb is missing its ${name} section`);
    }
    const wire = wireNode.clone();
    const bulb = bulbNode.clone();
    // Each section was modelled further along the wire; here each is centred.
    wire.position.set(0, 0, 0);
    bulb.position.set(0, 0, 0);
    // A bulb is modelled sticking out of its node along +Z.
    const bulbDirection = new Vector3(0, 0, 1).applyQuaternion(bulbNode.quaternion);
    bulbDirection.z = 0;
    bulbDirection.normalize();

    // The glass is drawn unlit and bright: it is the light. Its socket keeps
    // the wire's material.
    const glass = new MeshBasicMaterial({ color: BULB_COLORS[name], toneMapped: false });
    const glowBox = new Box3();
    bulb.updateMatrixWorld(true);
    bulb.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const material = object.material as Material;
      if (!material.name.startsWith("bulb_")) return;
      object.material = glass;
      glowBox.expandByObject(object);
    });
    const glowCenter = glowBox.isEmpty() ? new Vector3() : glowBox.getCenter(new Vector3());

    const sprite = new Sprite(haloMaterial(halo, LIGHT_COLORS[name]));
    sprite.position.copy(glowCenter);
    sprite.scale.setScalar(HALO_SIZE / THICKNESS);
    sprite.castShadow = false;
    bulb.add(sprite);

    return { wire, bulb, bulbDirection, glowCenter, lightColor: new Color(LIGHT_COLORS[name]) };
  });
  return { units };
}

interface Segment {
  readonly root: Group;
  readonly wire: Group;
  readonly bulb: Group;
  readonly bulbDirection: Vector3;
  readonly glowCenter: Vector3;
  readonly lightColor: Color;
}

function createSegment(parts: RopeParts, index: number): Segment {
  const unit = parts.units[index % parts.units.length];
  if (unit === undefined) throw new Error("no rope sections");
  const root = new Group();
  const wire = new Group();
  const bulb = new Group();
  wire.add(unit.wire.clone());
  bulb.add(unit.bulb.clone());
  root.add(wire, bulb);
  return {
    root,
    wire,
    bulb,
    bulbDirection: unit.bulbDirection,
    glowCenter: unit.glowCenter,
    lightColor: unit.lightColor,
  };
}

const Z_AXIS = new Vector3(0, 0, 1);
const DOWN = new Vector3(0, -1, 0);
const axis = new Vector3();
const bulbNow = new Vector3();
const wanted = new Vector3();
const cross = new Vector3();
const base = new Quaternion();
const roll = new Quaternion();
const glowAt = new Vector3();

/**
 * Lays a segment between two points, its bulb turned as near `towards` as the
 * wire's direction allows. A wire pointing nearly along `towards` has no
 * sideways to turn to, and keeps whatever turn it had.
 */
function placeSegment(
  segment: Segment,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  towards: Vector3,
): void {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.hypot(dx, dy, dz);
  const { root } = segment;
  if (length < 1e-6) {
    root.visible = false;
    return;
  }
  root.visible = true;
  axis.set(dx / length, dy / length, dz / length);
  base.setFromUnitVectors(Z_AXIS, axis);

  bulbNow.copy(segment.bulbDirection).applyQuaternion(base);
  bulbNow.addScaledVector(axis, -bulbNow.dot(axis));
  wanted.copy(towards).addScaledVector(axis, -towards.dot(axis));
  if (wanted.lengthSq() > 0.04) {
    const angle = Math.atan2(axis.dot(cross.crossVectors(bulbNow, wanted)), bulbNow.dot(wanted));
    roll.setFromAxisAngle(axis, angle);
    base.premultiply(roll);
  }

  root.quaternion.copy(base);
  root.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  segment.wire.scale.set(THICKNESS, THICKNESS, length / AUTHORED_SECTION);
  segment.bulb.scale.setScalar(THICKNESS);
}

/** A row of lights, one per segment of a rope. */
export class RopeChain {
  readonly root = new Group();
  private readonly segments: Segment[] = [];

  constructor(parts: RopeParts, count: number) {
    for (let i = 0; i < count; i++) {
      const segment = createSegment(parts, i);
      this.segments.push(segment);
      this.root.add(segment.root);
    }
  }

  /** Along the nodes of a simulated rope, bulbs hanging down. */
  follow(rope: Rope): void {
    const p = rope.positions;
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      if (segment === undefined) continue;
      const a = i * 3;
      placeSegment(
        segment,
        p[a] ?? 0,
        p[a + 1] ?? 0,
        p[a + 2] ?? 0,
        p[a + 3] ?? 0,
        p[a + 4] ?? 0,
        p[a + 5] ?? 0,
        DOWN,
      );
    }
  }

  /** Taut and straight between two points. */
  stretch(ax: number, ay: number, az: number, bx: number, by: number, bz: number): void {
    const n = this.segments.length;
    for (let i = 0; i < n; i++) {
      const segment = this.segments[i];
      if (segment === undefined) continue;
      const t0 = i / n;
      const t1 = (i + 1) / n;
      placeSegment(
        segment,
        ax + (bx - ax) * t0,
        ay + (by - ay) * t0,
        az + (bz - az) * t0,
        ax + (bx - ax) * t1,
        ay + (by - ay) * t1,
        az + (bz - az) * t1,
        DOWN,
      );
    }
  }

  /** Offers each bulb, where it is now, as a light. The chain must sit in world space. */
  offerLights(): void {
    if (!this.root.visible) return;
    const lights: number[] = [];
    this.collectLights(lights);
    for (let i = 0; i < lights.length; i += 6) {
      bulbLights.offer(
        lights[i] ?? 0,
        lights[i + 1] ?? 0,
        lights[i + 2] ?? 0,
        lights[i + 3] ?? 0,
        lights[i + 4] ?? 0,
        lights[i + 5] ?? 0,
      );
    }
  }

  /** Appends x, y, z, r, g, b for each bulb where it is now. The chain must sit in world space. */
  collectLights(out: number[]): void {
    for (const segment of this.segments) {
      if (!segment.root.visible) continue;
      glowAt
        .copy(segment.glowCenter)
        .multiplyScalar(THICKNESS)
        .applyQuaternion(segment.root.quaternion)
        .add(segment.root.position);
      const { r, g, b } = segment.lightColor;
      out.push(glowAt.x, glowAt.y, glowAt.z, r, g, b);
    }
  }

  /** Along a row of points, bulbs facing `outward(midpoint)`. */
  along(points: readonly Vector3[], outward: (mid: Vector3, out: Vector3) => void): void {
    const mid = new Vector3();
    const out = new Vector3();
    for (let i = 0; i < this.segments.length; i++) {
      const segment = this.segments[i];
      const a = points[i];
      const b = points[i + 1];
      if (segment === undefined || a === undefined || b === undefined) continue;
      mid.addVectors(a, b).multiplyScalar(0.5);
      outward(mid, out);
      placeSegment(segment, a.x, a.y, a.z, b.x, b.y, b.z, out);
    }
  }
}

const COIL_RADIUS = 0.1;
const COIL_TURNS = 2.4;
const COIL_PITCH = 0.034;
const COIL_SEGMENTS = 24;

/**
 * The string wound up: a flat spiral centred on the origin, its bulbs out
 * round the rim. This is how a rope looks as an item, anywhere but tied.
 */
export function buildCoil(parts: RopeParts): Object3D {
  const points: Vector3[] = [];
  const total = COIL_TURNS * Math.PI * 2;
  for (let i = 0; i <= COIL_SEGMENTS; i++) {
    const angle = (i / COIL_SEGMENTS) * total;
    points.push(
      new Vector3(
        Math.cos(angle) * COIL_RADIUS,
        (i / COIL_SEGMENTS - 0.5) * COIL_TURNS * COIL_PITCH,
        Math.sin(angle) * COIL_RADIUS,
      ),
    );
  }
  const chain = new RopeChain(parts, COIL_SEGMENTS);
  chain.along(points, (mid, out) => out.set(mid.x, 0, mid.z).normalize());
  // Lying flat; wrapped so a clone is posed from its own origin.
  const coil = new Group();
  coil.add(chain.root);
  chain.root.traverse((object) => {
    if (object instanceof Mesh) object.castShadow = false;
  });
  return coil;
}

/** Every tied rope in the world, plus the one being tied. */
export class RopesView {
  private readonly chains = new Map<number, RopeChain>();
  private readonly alive = new Set<number>();
  private preview: RopeChain | undefined;
  private previewSegments = 0;

  constructor(
    private readonly scene: Scene,
    private readonly parts: RopeParts,
    private readonly segments: number,
  ) {}

  sync(field: RopeField): void {
    this.alive.clear();
    for (const rope of field.ropes) {
      this.alive.add(rope.id);
      let chain = this.chains.get(rope.id);
      if (chain === undefined) {
        chain = new RopeChain(this.parts, rope.spec.segments);
        this.scene.add(chain.root);
        this.chains.set(rope.id, chain);
      }
      chain.follow(rope);
    }
    for (const [id, chain] of this.chains) {
      if (this.alive.has(id)) continue;
      this.scene.remove(chain.root);
      this.chains.delete(id);
    }
  }

  /** The string held out from its first tie to where the player is aiming, or nothing. */
  showPreview(
    from: { x: number; y: number; z: number } | undefined,
    toX: number,
    toY: number,
    toZ: number,
    segments = this.segments,
  ): void {
    if (from === undefined) {
      if (this.preview !== undefined) this.preview.root.visible = false;
      return;
    }
    if (this.preview !== undefined && this.previewSegments !== segments) {
      // Another string was run on: a longer chain.
      this.scene.remove(this.preview.root);
      this.preview = undefined;
    }
    if (this.preview === undefined) {
      this.preview = new RopeChain(this.parts, segments);
      this.previewSegments = segments;
      this.scene.add(this.preview.root);
    }
    this.preview.root.visible = true;
    this.preview.stretch(from.x, from.y, from.z, toX, toY, toZ);
  }

  /** Hands every tied (and being-tied) bulb to the glow pool, nearest the eye first. */
  publishLights(eyeX: number, eyeY: number, eyeZ: number, extra?: () => void): void {
    bulbLights.begin(eyeX, eyeY, eyeZ);
    extra?.();
    for (const chain of this.chains.values()) chain.offerLights();
    this.preview?.offerLights();
    bulbLights.commit();
  }

  clear(): void {
    bulbLights.begin(0, 0, 0);
    bulbLights.commit();
    for (const chain of this.chains.values()) this.scene.remove(chain.root);
    this.chains.clear();
    if (this.preview !== undefined) this.scene.remove(this.preview.root);
    this.preview = undefined;
  }
}
