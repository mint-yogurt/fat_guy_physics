import {
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  Scene,
  Vector3,
  Euler,
  type Object3D,
  PerspectiveCamera,
  type WebGPURenderer,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import type { ItemAssets } from "./itemAssets.ts";
import { faceOutward } from "./meshOrientation.ts";

/**
 * The first-person arm, from assets/meshes/player_arm_fpv.glb.
 *
 * Drawn in its own scene after the world, with the depth buffer cleared in
 * between, so it never pokes into a wall or a hill. The arm lives in camera
 * space: the camera is its parent in all but name (see `render`).
 *
 * The file's parts are flat nodes in arm space: +Y runs shoulder to fingertip,
 * the thumb sticks out along +X, and the palm is a slab facing +-Z. Which of
 * +Z/-Z is the inside of the hand is not recorded anywhere in the file, so
 * `PALM_SIGN` is the one number to flip if the fingers curl the wrong way.
 *
 * Rest pose is the chop: hand upright, thumb folded up alongside the fingers
 * (the file's own pose has it stuck out sideways, which is what the thumb
 * group undoes). Everything else is a few rotations about named pivots.
 *
 * The hand can hold the equipped item. A stick is gripped in a fist near its
 * plain end, fork up and forward like a sword, and turns to point straight
 * ahead while a throw is charged; a log rides on the upturned palm. The grip
 * numbers below were placed from the file's measurements, not by eye -- if
 * the stick floats beside the fist rather than through it, `STICK_GRIP` is
 * the one to move.
 */

const MODEL_URL = "/meshes/player_arm_fpv.glb";

/** +1 if the palm faces +Z in arm space, -1 if it faces -Z. */
const PALM_SIGN = 1;

/** Metres per file unit: the whole arm is about 22 of them. */
const ARM_SCALE = 0.03;

/** Shoulder position in camera space, and the rest pose's aim. */
const SHOULDER = new Vector3(0.3, -0.42, -0.02);
const REST_PITCH = 0.3;
const REST_YAW = 0.2;

// Pivots in arm space (file units).
const WRIST = new Vector3(0, 16.6, 0);
const KNUCKLE = new Vector3(0, 19.4, 0);
const FINGER_JOINT = new Vector3(0, 20.56, 0);
const THUMB_ROOT = new Vector3(1.15, 18.11, 0);
/** How far the thumb slides inboard-to-outboard when it folds up. */
const THUMB_FOLD_SHIFT = 0.55;

/**
 * Where a held item sits, in hand space (file units, origin at the wrist):
 * in front of the palm, at the height the curled fingers close.
 */
const STICK_GRIP = new Vector3(0, 2.1, 2.1 * PALM_SIGN);
const LOG_REST = new Vector3(0, 1.6, 5.2 * PALM_SIGN);
/** The stick tilts this far from the thumb's line towards the arm's (forward), at rest. */
const STICK_SWORD_TILT = 0.6;
/** A held log is drawn smaller than one on the ground, so it fits the hand. */
const HELD_LOG_SCALE = 0.65;
/** Seconds the throw's follow-through lasts. */
const THROW_KICK_SECONDS = 0.28;

const TAU = Math.PI * 2;
const STICK_AXIS = new Vector3(0, 0, 1);

const squash = (name: string): string => name.replace(/[^a-z0-9]/gi, "");

/** Swing cycle: slow raise, fast strike. 0..1 in, 0..1 out (1 = raised). */
function chopShape(p: number): number {
  if (p < 0.65) {
    const t = p / 0.65;
    return t * t * (3 - 2 * t);
  }
  const t = (p - 0.65) / 0.35;
  return 1 - t * t;
}

export interface ArmState {
  /** Left mouse (scoop) held. */
  scooping: boolean;
  /** Right mouse (chup) held. */
  chopping: boolean;
  /** Seconds per swing/scoop cycle. */
  chopPeriod: number;
  scoopPeriod: number;
  /** Horizontal speed over walk speed, 0..1, for the walking sway. */
  walk: number;
  grounded: boolean;
  /** What is in the hand, if anything. */
  held: "stick" | "log" | undefined;
  /** Spear throw being charged, 0..1; 0 when not charging. */
  charge: number;
  /** True on the frame a throw is released. */
  threw: boolean;
}

export class ArmViewmodel {
  readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera();

  private readonly shoulder = new Group();
  private readonly roll = new Group();
  private readonly hand = new Group();
  private readonly fingerBase = new Group();
  private readonly fingerTips = new Group();
  private readonly thumb = new Group();
  /** In metres, at the grip point: whatever the hand is holding. */
  private readonly holder = new Group();
  private readonly heldStick: Object3D;
  private readonly heldLog: Object3D;
  private readonly swordQuat = new Quaternion();
  private readonly spearQuat = new Quaternion();

  private readonly baseQuat = new Quaternion();
  private readonly poseQuat = new Quaternion();
  private readonly euler = new Euler(0, 0, 0, "YXZ");

  private chopWeight = 0;
  private chopPhase = 0;
  private scoopWeight = 0;
  private scoopPhase = 0;
  private walkPhase = 0;
  private walkAmount = 0;
  private gripWeight = 0;
  private carryWeight = 0;
  private chargeWeight = 0;
  private kick = 0;

  /** Hidden in third person and while tucked into a ball. */
  visible = true;

  private constructor(parts: Map<string, Mesh>, skin: string, items: ItemAssets) {
    const light = new HemisphereLight(0xcfe4f5, 0x4a3a2a, 2.4);
    const sun = new DirectionalLight(0xfff4e0, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(light, sun);

    const material = new MeshLambertMaterial({ color: skin });
    for (const mesh of parts.values()) {
      mesh.material = material;
      mesh.frustumCulled = false;
    }

    const part = (name: string): Mesh => {
      const mesh = parts.get(squash(name));
      if (mesh === undefined) throw new Error(`player_arm_fpv.glb is missing part "${name}"`);
      return mesh;
    };

    // Hierarchy: shoulder -> roll -> { upper, forearm, hand -> { palm,
    // fingerBase -> { base, fingerTips -> tips }, thumb -> { base, tips } } }.
    // Every group sits at its own pivot and its meshes are shifted back by
    // the same amount, so a mesh keeps its authored place at rest.
    const place = (group: Group, parent: Group, pivot: Vector3, parentPivot: Vector3): void => {
      group.position.copy(pivot).sub(parentPivot);
      parent.add(group);
    };
    const hold = (group: Group, mesh: Mesh, pivot: Vector3): void => {
      mesh.position.sub(pivot);
      group.add(mesh);
    };

    this.shoulder.add(this.roll);
    this.roll.add(part("arm.upper"), part("forearm"));

    place(this.hand, this.roll, WRIST, new Vector3());
    hold(this.hand, part("hand/palm"), WRIST);

    place(this.fingerBase, this.hand, KNUCKLE, WRIST);
    hold(this.fingerBase, part("fingers.base"), KNUCKLE);
    place(this.fingerTips, this.fingerBase, FINGER_JOINT, KNUCKLE);
    hold(this.fingerTips, part("fingers.tips"), FINGER_JOINT);

    place(this.thumb, this.hand, THUMB_ROOT, WRIST);
    hold(this.thumb, part("thumb.base"), THUMB_ROOT);
    hold(this.thumb, part("thumb.tips"), THUMB_ROOT);

    // The holder undoes the arm's scale, so what it holds is in metres.
    this.holder.scale.setScalar(1 / ARM_SCALE);
    this.hand.add(this.holder);
    this.heldStick = items.stick.clone();
    this.heldLog = items.log.clone();
    this.heldLog.scale.multiplyScalar(HELD_LOG_SCALE);
    // Lying across the palm: log +Y along the thumb's line.
    this.heldLog.rotation.z = -Math.PI / 2;
    for (const held of [this.heldStick, this.heldLog]) {
      held.visible = false;
      held.traverse((object) => {
        object.frustumCulled = false;
      });
      this.holder.add(held);
    }
    // Sword: fork along the thumb (up, at rest), leaning forward. Spear:
    // fork straight down the arm, which is straight ahead.
    this.swordQuat.setFromUnitVectors(
      STICK_AXIS,
      new Vector3(Math.cos(STICK_SWORD_TILT), Math.sin(STICK_SWORD_TILT), 0),
    );
    this.spearQuat.setFromUnitVectors(STICK_AXIS, new Vector3(0.15, 1, 0).normalize());
    this.stickGrip = items.stickGrip;

    this.shoulder.scale.setScalar(ARM_SCALE);
    this.shoulder.position.copy(SHOULDER);
    this.scene.add(this.shoulder);

    // Arm +Y -> camera forward (-Z), arm +X (thumb) -> camera up.
    this.baseQuat.setFromRotationMatrix(
      new Matrix4().makeBasis(new Vector3(0, 1, 0), new Vector3(0, 0, -1), new Vector3(-1, 0, 0)),
    );
  }

  private readonly stickGrip: number;

  static async load(skin: string, items: ItemAssets): Promise<ArmViewmodel> {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const parts = new Map<string, Mesh>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      faceOutward(object.geometry);
      // The file's labels are on the nodes, which GLTFLoader puts on the
      // single Mesh -- minus the punctuation it strips ("hand/palm").
      parts.set(squash(object.name), object);
    });
    return new ArmViewmodel(parts, skin, items);
  }

  update(dt: number, s: ArmState): void {
    const rate = Math.min(1, dt * 12);
    this.chopWeight += rate * ((s.chopping ? 1 : 0) - this.chopWeight);
    this.scoopWeight += rate * ((s.scooping && !s.chopping ? 1 : 0) - this.scoopWeight);
    if (this.chopWeight > 0.01) this.chopPhase = (this.chopPhase + dt / s.chopPeriod) % 1;
    else this.chopPhase = 0;
    if (this.scoopWeight > 0.01) this.scoopPhase = (this.scoopPhase + dt / s.scoopPeriod) % 1;
    else this.scoopPhase = 0;

    this.gripWeight += rate * ((s.held === undefined ? 0 : 1) - this.gripWeight);
    this.carryWeight += rate * ((s.held === "log" ? 1 : 0) - this.carryWeight);
    this.chargeWeight += Math.min(1, dt * 8) * (s.charge - this.chargeWeight);
    if (s.threw) {
      this.kick = 1;
      this.chargeWeight = 0;
    }
    this.kick = Math.max(0, this.kick - dt / THROW_KICK_SECONDS);
    // Follow-through: a fast lunge forward, easing back.
    const lunge = Math.sin(this.kick * Math.PI) * (this.kick > 0 ? 1 : 0);

    const walking = s.grounded ? s.walk : 0;
    this.walkAmount += rate * (walking - this.walkAmount);
    this.walkPhase += dt * 7 * walking;

    const chop = chopShape(this.chopPhase) * this.chopWeight;
    // Scoop: 0 -> dip down and out, 0.5 -> palm up and curled, 1 -> lifted.
    const sp = this.scoopPhase * TAU;
    const dip = (0.5 - 0.5 * Math.cos(sp)) * this.scoopWeight; // 0..1..0
    const lift = Math.max(0, Math.sin(sp - 0.6)) * this.scoopWeight;

    // Pose: aim in camera space, then swing, dip and bob on top.
    const bobX = Math.cos(this.walkPhase * 0.5) * 0.012 * this.walkAmount;
    const bobY = Math.abs(Math.sin(this.walkPhase)) * 0.015 * this.walkAmount;
    // Charging a throw draws the arm back and up; releasing it lunges.
    const draw = this.chargeWeight;
    this.shoulder.position.set(
      SHOULDER.x + bobX - 0.05 * dip - 0.04 * draw,
      SHOULDER.y + bobY - 0.06 * dip + 0.02 * lift + 0.12 * draw + 0.04 * lunge - 0.04 * this.carryWeight,
      SHOULDER.z - 0.06 * dip + 0.16 * draw - 0.22 * lunge,
    );
    this.euler.set(
      REST_PITCH +
        0.55 * chop -
        0.7 * dip +
        0.35 * lift -
        0.35 * this.chopWeight * (1 - chop) +
        0.2 * draw -
        0.15 * lunge -
        0.25 * this.carryWeight,
      REST_YAW - 0.15 * this.scoopWeight - 0.12 * draw,
      0,
    );
    this.poseQuat.setFromEuler(this.euler).multiply(this.baseQuat);
    this.shoulder.quaternion.copy(this.poseQuat);

    // Forearm roll turns the palm to the sky for the scoop.
    // A log is carried the same way, palm up under it.
    this.roll.rotation.y = (Math.PI / 2) * 0.9 * Math.max(dip, this.carryWeight) * PALM_SIGN;

    // Chop keeps the hand flat; scoop cups it. Rotation about X curls the
    // fingers towards +Z, so the sign carries the palm side.
    const cup = (0.2 + 0.8 * dip) * this.scoopWeight;
    // Holding a stick closes the hand into a fist round it; a log only
    // curls the fingers enough to cradle it.
    const fist = this.gripWeight * (1 - this.carryWeight);
    const cradle = this.carryWeight * 0.4;
    this.hand.rotation.x = PALM_SIGN * (-0.2 * chop + 0.3 * dip);
    this.fingerBase.rotation.x = PALM_SIGN * Math.max(0.8 * cup, 1.5 * fist, cradle);
    this.fingerTips.rotation.x = PALM_SIGN * Math.max(0.9 * cup, 1.4 * fist, cradle);

    this.heldStick.visible = s.held === "stick" && this.kick <= 0.35;
    this.heldLog.visible = s.held === "log";
    if (s.held === "log") {
      this.holder.position.copy(LOG_REST);
      this.holder.quaternion.identity();
    } else {
      this.holder.position.copy(STICK_GRIP);
      this.holder.quaternion.copy(this.swordQuat).slerp(this.spearQuat, draw);
      // The grip is a little way up from the butt, so the holder's origin
      // is that point on the shaft.
      this.heldStick.position.set(0, 0, -this.stickGrip);
    }

    // Thumb folds up along the fingers (the chop) unless scooping, where it
    // opens back out a little as if to hold the scoop.
    const fold = 1 - 0.35 * this.scoopWeight * dip;
    this.thumb.rotation.z = (Math.PI / 2) * fold;
    this.thumb.position
      .copy(THUMB_ROOT)
      .sub(WRIST)
      .add(new Vector3(THUMB_FOLD_SHIFT * fold, 0, 0));
  }

  /** Draws the arm over whatever the main pass left, ignoring its depth. */
  render(renderer: WebGPURenderer, camera: PerspectiveCamera): void {
    if (!this.visible) return;
    // Own camera at the origin, sharing only the projection: the arm stays
    // in view space however the main camera moves.
    this.camera.projectionMatrix.copy(camera.projectionMatrix);
    this.camera.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    const savedAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = savedAuto;
  }

  dispose(): void {
    this.scene.clear();
  }
}
