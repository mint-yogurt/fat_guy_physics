import {
  DirectionalLight,
  Group,
  HemisphereLight,
  Matrix4,
  Mesh,
  MeshLambertNodeMaterial,
  Quaternion,
  Scene,
  Vector3,
  Euler,
  PerspectiveCamera,
  type Object3D,
  type WebGPURenderer,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import {
  AvatarAction,
  CHUP_CYCLE_SECONDS,
  HoldStyle,
  leavesHandOnThrow,
  SCOOP_CYCLE_SECONDS,
  SHAKE_CYCLE_SECONDS,
  THROW_FOLLOW_SECONDS,
  ThrowWatcher,
  type AvatarPose,
} from "@fgp/shared/items/avatarPose";
import { ItemType } from "@fgp/shared/items/inventory";
import { placementOf } from "@fgp/shared/items/placement";

import { HeldItemSlot, type HeldItemSources } from "./heldItems.ts";
import { faceOutward } from "./meshOrientation.ts";
import { litByBulbs } from "./bulbLights.ts";

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
 * The hand holds the equipped item, posed by its hold style (see
 * @fgp/shared/items/avatarPose): a blade (stick) is gripped in a fist near
 * its plain end, fork up and forward like a sword, and turns to point
 * straight ahead while a throw is charged; a carried item (log) rides on the
 * upturned palm; a pinched one (leaf) sits at the fingertips. The grip
 * numbers below were placed from the file's measurements, not by eye -- if
 * the stick floats beside the fist rather than through it, `STICK_GRIP` is
 * the one to move.
 *
 * It is driven by the same `AvatarPose` as the third-person character, so
 * what you see in your own hand is what everyone else sees you doing.
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
const PINCH_POINT = new Vector3(0.6, 4.6, 1.4 * PALM_SIGN);
/** A snowball sits on the palm, held there by the half-closed fingers. */
const BALL_POINT = new Vector3(0, 3.4, 5.4 * PALM_SIGN);
/**
 * A roll of toilet paper: its middle (the roll is 5.4 units across, axis along the thumb) sits so its
 * side rests on the palm and the curled fingertips dig into it. The palm's face is at z = 0.9.
 */
const PAPER_POINT = new Vector3(0, 2.6, 3.5 * PALM_SIGN);
/** The stick tilts this far from the thumb's line towards the arm's (forward), at rest. */
const STICK_SWORD_TILT = 0.6;

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
  pose: AvatarPose;
  /** Horizontal speed over walk speed, 0..1, for the walking sway. */
  walk: number;
  grounded: boolean;
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
  private readonly held: HeldItemSlot;
  private readonly throws = new ThrowWatcher();
  private readonly swordQuat = new Quaternion();
  private readonly spearQuat = new Quaternion();
  /** A fishing rod drawn back for a cast: tip up and back over the shoulder, towards the camera. */
  private readonly rodBackQuat = new Quaternion();

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
  private shakeWeight = 0;
  private shakePhase = 0;
  private bowlWeight = 0;
  private lobWeight = 0;
  /** A roll of toilet paper being bowled: the wrist turned a quarter so the roll stands like a wheel. */
  private paperTwist = 0;
  private kick = 0;
  /** The wind-up the follow-through under way came out of. */
  private kickKind: AvatarAction = AvatarAction.Charge;

  /** Hidden in third person and while tucked into a ball. */
  visible = true;

  private constructor(
    parts: Map<string, Mesh>,
    skin: string,
    items: HeldItemSources,
  ) {
    const light = new HemisphereLight(0xcfe4f5, 0x4a3a2a, 2.4);
    const sun = new DirectionalLight(0xfff4e0, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(light, sun);

    const material = litByBulbs(new MeshLambertNodeMaterial({ color: skin }));
    for (const mesh of parts.values()) {
      mesh.material = material;
      mesh.frustumCulled = false;
    }

    const part = (name: string): Mesh => {
      const mesh = parts.get(squash(name));
      if (mesh === undefined)
        throw new Error(`player_arm_fpv.glb is missing part "${name}"`);
      return mesh;
    };

    // Hierarchy: shoulder -> roll -> { upper, forearm, hand -> { palm,
    // fingerBase -> { base, fingerTips -> tips }, thumb -> { base, tips } } }.
    // Every group sits at its own pivot and its meshes are shifted back by
    // the same amount, so a mesh keeps its authored place at rest.
    const place = (
      group: Group,
      parent: Group,
      pivot: Vector3,
      parentPivot: Vector3,
    ): void => {
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
    // A carried item's long axis (+X) lies along the thumb's line, across
    // the palm, with the holder unturned.
    this.held = new HeldItemSlot(this.holder, items);
    // Sword: fork along the thumb (up, at rest), leaning forward. Spear:
    // fork straight down the arm, which is straight ahead.
    this.swordQuat.setFromUnitVectors(
      STICK_AXIS,
      new Vector3(Math.cos(STICK_SWORD_TILT), Math.sin(STICK_SWORD_TILT), 0),
    );
    this.spearQuat.setFromUnitVectors(
      STICK_AXIS,
      new Vector3(0.15, 1, 0).normalize(),
    );
    // Arm +X is camera up and arm +Y is forward, so -Y is back towards the camera.
    this.rodBackQuat.setFromUnitVectors(STICK_AXIS, new Vector3(0.8, -0.45, 0).normalize());

    this.shoulder.scale.setScalar(ARM_SCALE);
    this.shoulder.position.copy(SHOULDER);
    this.scene.add(this.shoulder);

    // Arm +Y -> camera forward (-Z), arm +X (thumb) -> camera up.
    this.baseQuat.setFromRotationMatrix(
      new Matrix4().makeBasis(
        new Vector3(0, 1, 0),
        new Vector3(0, 0, -1),
        new Vector3(-1, 0, 0),
      ),
    );
  }

  static async load(
    skin: string,
    items: HeldItemSources,
  ): Promise<ArmViewmodel> {
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
    const pose = s.pose;
    const rate = Math.min(1, dt * 12);
    const chopping = pose.action === AvatarAction.Chup;
    const scooping = pose.action === AvatarAction.Scoop;
    // A snowball put overhand is cocked the way a spear is drawn: arm back and up.
    const charge =
      pose.action === AvatarAction.Charge || pose.action === AvatarAction.Put
        ? pose.charge
        : 0;
    this.chopWeight += rate * ((chopping ? 1 : 0) - this.chopWeight);
    this.scoopWeight += rate * ((scooping ? 1 : 0) - this.scoopWeight);
    this.shakeWeight += rate * ((pose.action === AvatarAction.Shake ? 1 : 0) - this.shakeWeight);
    if (this.shakeWeight > 0.01) this.shakePhase = (this.shakePhase + dt / SHAKE_CYCLE_SECONDS) % 1;
    else this.shakePhase = 0;
    if (this.chopWeight > 0.01)
      this.chopPhase = (this.chopPhase + dt / CHUP_CYCLE_SECONDS) % 1;
    else this.chopPhase = 0;
    if (this.scoopWeight > 0.01)
      this.scoopPhase = (this.scoopPhase + dt / SCOOP_CYCLE_SECONDS) % 1;
    else this.scoopPhase = 0;

    // Something that is only for placing is not held up in front of the view:
    // the ghost of it in the world says where it goes. Others still see it carried.
    const held = placementOf(pose.held)?.hideHeldInFirstPerson === true ? undefined : pose.held;
    const style = this.held.show(held);
    // A pinch is a light grip: fingers half closed.
    const grip =
      style === HoldStyle.Empty
        ? 0
        : style === HoldStyle.Pinch || style === HoldStyle.Ball
          ? 0.45
          : 1;
    this.gripWeight += rate * (grip - this.gripWeight);
    this.carryWeight +=
      rate * ((style === HoldStyle.Carry ? 1 : 0) - this.carryWeight);
    const windRate = Math.min(1, dt * 8);
    this.chargeWeight += windRate * (charge - this.chargeWeight);
    const bowl = pose.action === AvatarAction.Bowl ? pose.charge : 0;
    const lob = pose.action === AvatarAction.Lob ? pose.charge : 0;
    this.bowlWeight += windRate * (bowl - this.bowlWeight);
    this.lobWeight += windRate * (lob - this.lobWeight);
    if (this.throws.check(pose.throwSeq)) {
      this.kick = 1;
      this.kickKind = pose.thrown;
      this.chargeWeight = 0;
      this.bowlWeight = 0;
      this.lobWeight = 0;
    }
    this.kick = Math.max(0, this.kick - dt / THROW_FOLLOW_SECONDS);
    // Follow-through: a fast swing, easing back, shaped by the wind-up.
    const swing = Math.sin(this.kick * Math.PI) * (this.kick > 0 ? 1 : 0);
    const lunge =
      this.kickKind === AvatarAction.Charge ||
      this.kickKind === AvatarAction.Put
        ? swing
        : 0;
    const bowlThrough = this.kickKind === AvatarAction.Bowl ? swing : 0;
    const lobThrough = this.kickKind === AvatarAction.Lob ? swing : 0;
    // Bowl: swung back low, then out along the ground. Lob: dropped down
    // by the knees, then up and out.
    const windBowl = this.bowlWeight;
    const windLob = this.lobWeight;
    // Toilet paper is bowled with the wrist turned a quarter (palm up) so it runs like a wheel, and thrown
    // side-arm out to the right rather than drawn up over the shoulder.
    const paper = held === ItemType.ToiletPaper;
    const bowling = pose.action === AvatarAction.Bowl || (this.kick > 0 && this.kickKind === AvatarAction.Bowl);
    this.paperTwist += rate * ((paper && bowling ? 1 : 0) - this.paperTwist);

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
    // Shaking: the fist comes up in front of the chest and is jerked up and down.
    const jerk = Math.sin(this.shakePhase * TAU) * this.shakeWeight;
    this.shoulder.position.set(
      SHOULDER.x + bobX - 0.05 * dip + (paper ? 0.1 : -0.04) * draw - 0.04 * this.shakeWeight,
      SHOULDER.y +
        bobY -
        0.06 * dip +
        0.02 * lift +
        (paper ? 0.02 : 0.12) * draw +
        0.04 * lunge +
        0.05 * this.shakeWeight +
        0.07 * jerk -
        0.04 * this.carryWeight -
        0.12 * windBowl -
        0.06 * bowlThrough -
        0.16 * windLob +
        0.06 * lobThrough,
      SHOULDER.z -
        0.06 * dip +
        0.16 * draw -
        0.22 * lunge +
        0.14 * windBowl -
        0.2 * bowlThrough +
        0.04 * windLob -
        0.16 * lobThrough,
    );
    this.euler.set(
      REST_PITCH +
        0.55 * chop -
        0.7 * dip +
        0.35 * lift -
        0.35 * this.chopWeight * (1 - chop) +
        (paper ? 0.04 : 0.2) * draw +
        0.3 * jerk -
        0.15 * lunge -
        0.25 * this.carryWeight -
        0.6 * windBowl -
        0.35 * bowlThrough -
        0.9 * windLob +
        0.6 * lobThrough,
      REST_YAW - 0.15 * this.scoopWeight - (paper ? 0.6 : 0.12) * draw - (paper ? 0.3 : 0) * lunge,
      0,
    );
    this.poseQuat.setFromEuler(this.euler).multiply(this.baseQuat);
    this.shoulder.quaternion.copy(this.poseQuat);

    // Forearm roll turns the palm to the sky for the scoop.
    // A log is carried the same way, palm up under it.
    this.roll.rotation.y =
      (Math.PI / 2) * 0.9 * Math.max(dip, this.carryWeight, this.paperTwist) * PALM_SIGN;

    // Chop keeps the hand flat; scoop cups it. Rotation about X curls the
    // fingers towards +Z, so the sign carries the palm side.
    const cup = (0.2 + 0.8 * dip) * this.scoopWeight;
    // Holding a stick closes the hand into a fist round it; a log only
    // curls the fingers enough to cradle it.
    const fist = this.gripWeight * (1 - this.carryWeight);
    const cradle = this.carryWeight * 0.4;
    this.hand.rotation.x = PALM_SIGN * (-0.2 * chop + 0.3 * dip);
    this.fingerBase.rotation.x =
      PALM_SIGN * Math.max(0.8 * cup, 1.5 * fist, cradle);
    this.fingerTips.rotation.x =
      PALM_SIGN * Math.max(0.9 * cup, 1.4 * fist, cradle);

    // A thrown stick or log has left the hand for the first part of the
    // follow-through; the next one from the stack appears as it ends.
    const throwable =
      (style === HoldStyle.Blade ||
        style === HoldStyle.Carry ||
        style === HoldStyle.Ball) &&
      leavesHandOnThrow(held);
    this.held.show(held, !throwable || this.kick <= 0.35);
    if (style === HoldStyle.Carry) {
      this.holder.position.copy(LOG_REST);
      this.holder.quaternion.identity();
    } else if (style === HoldStyle.Pinch) {
      this.holder.position.copy(PINCH_POINT);
      this.holder.quaternion.identity();
    } else if (style === HoldStyle.Ball) {
      this.holder.position.copy(paper ? PAPER_POINT : BALL_POINT);
      this.holder.quaternion.identity();
    } else {
      this.holder.position.copy(STICK_GRIP);
      this.holder.quaternion.copy(this.swordQuat);
      if (held === ItemType.FishingRod) {
        // A cast draws the rod back over the shoulder and whips it forward on release.
        this.holder.quaternion.slerp(this.rodBackQuat, draw).slerp(this.spearQuat, lunge);
      } else {
        this.holder.quaternion.slerp(this.spearQuat, draw);
      }
    }
    this.held.settleRod(draw < 0.02 && lunge < 0.02);
    this.held.animate(performance.now() / 1000);

    // Thumb folds up along the fingers (the chop) unless scooping, where it
    // opens back out a little as if to hold the scoop.
    const fold = 1 - 0.35 * this.scoopWeight * dip;
    this.thumb.rotation.z = (Math.PI / 2) * fold;
    this.thumb.position
      .copy(THUMB_ROOT)
      .sub(WRIST)
      .add(new Vector3(THUMB_FOLD_SHIFT * fold, 0, 0));
  }

  /**
   * A named point on the item in the hand (the fishing rod's line tip). The arm has its own
   * scene in view space, so the point's world position is in the camera's frame.
   */
  heldAnchor(name: string): Object3D | undefined {
    return this.held.anchor(name);
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
