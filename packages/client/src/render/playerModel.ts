import {
  Box3,
  BufferAttribute,
  Group,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type Scene,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { PlayerMode, WALK_HEIGHT, type Player } from "@fgp/shared/sim/player";

/**
 * The player character, from assets/meshes/playermodel_v2.glb.
 *
 * Orientation and scale are Object3D transforms over the file's own parts,
 * which are used exactly as exported -- the T-pose layout and the normals
 * are whatever the artist made them.
 *
 * Limbs are the exception, deliberately: rotating a limb's whole mesh
 * tears it off the torso at the joint. Each limb is instead deformed per
 * vertex from a kept copy of its original data, weighted by how far down
 * the limb a vertex sits -- the vertices against the body do not move at
 * all, and the far end takes the full rotation. That is one-bone smooth
 * skinning, done on the CPU because the limbs are a few hundred vertices
 * each and that is cheaper than inventing a skinned mesh the file does
 * not contain.
 *
 * Axes, measured off the exported parts rather than assumed: the model
 * lies on its back with the head toward -X and the arms spread along Y,
 * and it faces -Z once stood up. The limb maths below is written in those
 * model axes, since the limbs live under the group that stands it up.
 */

export interface Appearance {
  name: string;
  skin: string;
  shirt: string;
  face: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  name: "fat guy",
  skin: "#d9a06a",
  shirt: "#2f6fb0",
  face: 0,
};

const MODEL_URL = "/meshes/playermodel_v2.glb";

const WALK_CYCLE_SPEED = 7;
const RETRACT_RATE = 9;

/** Vertical bounce at each footfall, in metres. */
const BOUNCE_HEIGHT = 0.07;

/**
 * Fraction of a limb's length over which the deformation ramps from
 * nothing to full. Low values read as a hinge, high values as rubber.
 */
const JOINT_BLEND = 0.65;

/** How far a tucked limb is drawn back towards its own joint. */
const TUCK_SHRINK = 0.7;

interface Limb {
  readonly mesh: Mesh;
  /** Untouched copies: every frame deforms from these, never in place. */
  readonly basePositions: Float32Array;
  readonly baseNormals: Float32Array | undefined;
  /** Per vertex, 0 at the joint and 1 at the free end. */
  readonly weights: Float32Array;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly pivotZ: number;
  /** 0 = rotate about model X (arms), 1 = about model Y (legs). */
  readonly axis: 0 | 1;
  /** +1 left, -1 right. */
  readonly sign: number;
}

export class PlayerModel {
  readonly root = new Group();

  /** Carries the ragball spin, pivoted at the torso's centre. */
  private readonly spin = new Group();
  /** Scale, and the offset that stands the model on the root. */
  private readonly fit = new Group();
  /** Model axes -> world axes. Everything under this is in model space. */
  private readonly orient = new Group();

  private readonly limbs: Limb[] = [];

  private baseScale = 1;
  private baseLift = 0;
  /** Height of the torso's centre above the feet: the ragball pivot. */
  private pivotHeight = 0;
  private tuck = 0;
  private phase = 0;
  private readonly rotation = new Quaternion();

  private constructor(
    private readonly scene: Scene,
    parts: Map<string, Mesh>,
    appearance: Appearance,
  ) {
    // Three turns stand the model up: one to bring the lateral axis onto
    // Z, one to lift the head off the floor, one to face +X, which is
    // where a yaw of zero points in the sim.
    const yAxis = new Vector3(0, 1, 0);
    const lateral = new Quaternion().setFromAxisAngle(yAxis, -Math.PI / 2);
    const stand = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
    const face = new Quaternion().setFromAxisAngle(yAxis, -Math.PI / 2);
    this.orient.quaternion.copy(face.multiply(stand).multiply(lateral));

    const skin = new MeshLambertMaterial({ color: appearance.skin });
    const shirt = new MeshLambertMaterial({ color: appearance.shirt });

    const box = new Box3();
    const pivot = new Vector3();
    let body: Mesh | undefined;

    for (const [name, mesh] of parts) {
      mesh.material = name === "body" ? shirt : skin;
      mesh.frustumCulled = false;
      mesh.geometry.computeBoundingBox();
      this.orient.add(mesh);

      const isArm = name.startsWith("arm");
      if (!isArm && !name.startsWith("leg")) {
        if (name === "body") body = mesh;
        continue;
      }

      box.copy(mesh.geometry.boundingBox ?? new Box3());
      box.getCenter(pivot);
      const left = name.endsWith("left");
      // An arm's joint is its inner end along the lateral axis, since the
      // arms are held out in the T-pose; a leg's is its top, and up is -X.
      if (isArm) pivot.y = left ? box.min.y : box.max.y;
      else pivot.x = box.min.x;

      this.limbs.push(buildLimb(mesh, pivot, isArm, left));
    }

    this.fit.add(this.orient);
    const bounds = new Box3().setFromObject(this.fit);
    const size = new Vector3();
    bounds.getSize(size);
    this.baseScale = size.y > 0 ? WALK_HEIGHT / size.y : 1;
    this.fit.scale.setScalar(this.baseScale);
    this.baseLift = -bounds.min.y * this.baseScale;

    const center = new Vector3();
    bounds.getCenter(center);
    this.fit.position.set(-center.x * this.baseScale, this.baseLift, -center.z * this.baseScale);

    this.spin.add(this.fit);
    this.root.add(this.spin);
    scene.add(this.root);

    // Ragball rolls about the torso's centre of mass, not the feet. The
    // sim's position is the bottom of the ball, so spinning the model
    // about that would swing the whole body around a point on the floor.
    // Measured from the assembled hierarchy rather than derived, because
    // deriving it means reproducing every transform above it by hand.
    const torsoBox = body?.geometry.boundingBox;
    if (torsoBox != null && body !== undefined) {
      this.root.updateWorldMatrix(true, true);
      const torso = torsoBox.getCenter(new Vector3());
      body.localToWorld(torso);
      this.root.worldToLocal(torso);
      this.pivotHeight = torso.y;
    } else {
      this.pivotHeight = WALK_HEIGHT / 2;
    }

    // Moving the pivot up and the model down by the same amount leaves it
    // standing exactly where it was.
    this.spin.position.y = this.pivotHeight;
    this.fit.position.y -= this.pivotHeight;
  }

  static async load(scene: Scene, appearance: Appearance): Promise<PlayerModel> {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const parts = new Map<string, Mesh>();
    gltf.scene.traverse((object) => {
      if (object instanceof Mesh) parts.set(object.name, object);
    });
    return new PlayerModel(scene, parts, appearance);
  }

  /** `dt` is a real frame delta: this is cosmetic, not part of the sim. */
  update(player: Player, dt: number, renderX: number, renderY: number, renderZ: number): void {
    this.root.position.set(renderX, renderY, renderZ);

    const ragball = player.mode === PlayerMode.Ragball;
    this.tuck += Math.min(1, dt * RETRACT_RATE) * ((ragball ? 1 : 0) - this.tuck);

    if (ragball) {
      this.rotation.set(
        player.orientationX,
        player.orientationY,
        player.orientationZ,
        player.orientationW,
      );
      this.spin.quaternion.copy(this.rotation);
    } else {
      this.spin.quaternion.identity();
      // From the front vector, not player.yaw, which is in degrees.
      this.spin.rotation.set(0, -Math.atan2(player.frontZ, player.frontX), 0);
    }

    const speed = Math.hypot(player.vx, player.vz);
    this.phase += dt * WALK_CYCLE_SPEED * Math.min(1, speed / player.walkSpeed);
    const gait = player.grounded ? Math.min(1, speed / 2) : 0;
    const swing = player.grounded ? Math.sin(this.phase) * gait * 0.7 : 0.3;
    const active = 1 - this.tuck;

    // Two bounces per stride, one per footfall.
    this.fit.position.y =
      this.baseLift -
      this.pivotHeight +
      Math.abs(Math.sin(this.phase)) * BOUNCE_HEIGHT * gait * active;

    // An arm lies along the lateral axis, so it swings forward about model
    // X; a leg hangs along +X, so it swings about model Y. One angle
    // serves both arms, which point opposite ways to begin with.
    for (const limb of this.limbs) {
      const angle =
        limb.axis === 0
          ? swing * active + this.tuck * 2.2
          : swing * limb.sign * active - this.tuck * 2.3;
      deformLimb(limb, angle, this.tuck);
    }
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}

function buildLimb(mesh: Mesh, pivot: Vector3, isArm: boolean, left: boolean): Limb {
  const position = mesh.geometry.getAttribute("position") as BufferAttribute;
  const normal = mesh.geometry.getAttribute("normal") as BufferAttribute | undefined;
  const basePositions = new Float32Array(position.array as Float32Array);
  const count = position.count;

  // Distance is measured along the limb's own length -- outward along the
  // lateral axis for an arm, downward for a leg -- so a vertex's weight
  // depends on how far down the limb it sits and not on how fat it is.
  const outX = isArm ? 0 : 1;
  const outY = isArm ? (left ? 1 : -1) : 0;

  let reach = 0;
  for (let i = 0; i < count; i++) {
    const dx = (basePositions[i * 3] ?? 0) - pivot.x;
    const dy = (basePositions[i * 3 + 1] ?? 0) - pivot.y;
    const along = dx * outX + dy * outY;
    if (along > reach) reach = along;
  }

  const weights = new Float32Array(count);
  const blend = Math.max(1e-6, reach * JOINT_BLEND);
  for (let i = 0; i < count; i++) {
    const dx = (basePositions[i * 3] ?? 0) - pivot.x;
    const dy = (basePositions[i * 3 + 1] ?? 0) - pivot.y;
    const along = dx * outX + dy * outY;
    const t = Math.min(1, Math.max(0, along / blend));
    // Smoothstep rather than linear: a linear ramp creases visibly where
    // it reaches full strength.
    weights[i] = t * t * (3 - 2 * t);
  }

  return {
    mesh,
    basePositions,
    baseNormals: normal === undefined ? undefined : new Float32Array(normal.array as Float32Array),
    weights,
    pivotX: pivot.x,
    pivotY: pivot.y,
    pivotZ: pivot.z,
    axis: isArm ? 0 : 1,
    sign: left ? 1 : -1,
  };
}

function deformLimb(limb: Limb, angle: number, tuck: number): void {
  const geometry = limb.mesh.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute;
  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  const out = position.array as Float32Array;
  const outNormal = normal?.array as Float32Array | undefined;
  const base = limb.basePositions;
  const baseNormals = limb.baseNormals;
  const weights = limb.weights;

  for (let i = 0; i < weights.length; i++) {
    const w = weights[i] ?? 0;
    const a = angle * w;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const o = i * 3;

    let x = (base[o] ?? 0) - limb.pivotX;
    let y = (base[o + 1] ?? 0) - limb.pivotY;
    let z = (base[o + 2] ?? 0) - limb.pivotZ;

    if (limb.axis === 0) {
      const ny = y * c - z * s;
      z = y * s + z * c;
      y = ny;
    } else {
      const nx = x * c + z * s;
      z = -x * s + z * c;
      x = nx;
    }

    // Tucking draws the limb in towards its own joint by the same weight,
    // so the shoulder and hip stay exactly where they are.
    const pull = 1 - tuck * TUCK_SHRINK * w;
    out[o] = limb.pivotX + x * pull;
    out[o + 1] = limb.pivotY + y * pull;
    out[o + 2] = limb.pivotZ + z * pull;

    if (baseNormals !== undefined && outNormal !== undefined) {
      const nx0 = baseNormals[o] ?? 0;
      const ny0 = baseNormals[o + 1] ?? 0;
      const nz0 = baseNormals[o + 2] ?? 0;
      if (limb.axis === 0) {
        outNormal[o] = nx0;
        outNormal[o + 1] = ny0 * c - nz0 * s;
        outNormal[o + 2] = ny0 * s + nz0 * c;
      } else {
        outNormal[o] = nx0 * c + nz0 * s;
        outNormal[o + 1] = ny0;
        outNormal[o + 2] = -nx0 * s + nz0 * c;
      }
    }
  }

  position.needsUpdate = true;
  if (normal !== undefined) normal.needsUpdate = true;
}
