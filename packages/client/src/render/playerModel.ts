import {
  Box3,
  BufferAttribute,
  Euler,
  Group,
  Mesh,
  MeshLambertNodeMaterial,
  Quaternion,
  type Object3D,
  Vector3,
  type Scene,
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
import { PlayerMode, WALK_HEIGHT, type Player } from "@fgp/shared/sim/player";

import { HeldItemSlot, type HeldItemSources } from "./heldItems.ts";
import { faceOutward } from "./meshOrientation.ts";
import { litByBulbs } from "./bulbLights.ts";

/**
 * The player character, from assets/meshes/playermodel_v2.glb.
 *
 * Orientation and scale are Object3D transforms over the file's own parts,
 * which are used as exported -- the T-pose layout is whatever the artist
 * made it -- with one correction: every part of this file is wound inside
 * out, so each is righted on load (see meshOrientation.ts). Without that the
 * body and head draw hollow, their near faces culled away.
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
 *
 * Hands and held items. Everything a character does with its hands comes
 * from an `AvatarPose` (@fgp/shared/items/avatarPose) -- the same four bytes
 * that drive the first-person arm, and what a remote player sends -- so
 * anyone watching sees you hold and use exactly what you have. Arm poses are
 * written in body space (X forward, Y up, Z to the character's right, metres)
 * as the direction the arm points from the shoulder; each frame that becomes
 * a rotation, carried into the limb's own axes, and the arm is bent along it with
 * the same per-vertex weights as the walk. The right hand's end of the
 * deformed arm is the grip point: a holder group sits there, in body space,
 * and the held item's mesh (render/heldItems.ts) goes in it, posed by the
 * item's hold style.
 *
 * The off hand joins in for two-handed things: the scoop, and carrying a log
 * across the chest.
 */

/**
 * The parts of a player a third-person character is drawn from: the local
 * sim's Player has all of these, and so will a remote player's snapshot.
 */
export type AvatarBody = Pick<
  Player,
  | "mode"
  | "orientationX"
  | "orientationY"
  | "orientationZ"
  | "orientationW"
  | "frontX"
  | "frontZ"
  | "vx"
  | "vz"
  | "walkSpeed"
  | "grounded"
  | "skating"
  | "skate"
  | "skateTilt"
  | "climbing"
  | "climb"
>;

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

// Arm poses: where the arm points from the shoulder, in body space (X
// forward, Y up, Z right). The right arm's; the left mirrors Z.
/** Holding something out in front, ready. */
const HOLD_AIM = new Vector3(0.6, -0.25, 0.75);
/** Empty-handed chup: hand raised, then chopped down in front. */
const CHUP_RAISED = new Vector3(0.3, 0.95, 0.35);
const CHUP_STRUCK = new Vector3(1, -0.4, 0.25);
/** Sword slash with a blade: high on the right, across to low front-left. */
const SLASH_RAISED = new Vector3(-0.15, 0.85, 0.75);
const SLASH_STRUCK = new Vector3(0.9, -0.3, -0.4);
/** Scoop: both hands dip forward and down, then lift. */
const SCOOP_DOWN = new Vector3(0.8, -0.85, 0.35);
const SCOOP_UP = new Vector3(0.95, 0.3, 0.3);
/** Charging a throw: arm drawn back and up behind the shoulder. */
const CHARGE_AIM = new Vector3(-0.65, 0.55, 0.6);
/** Shaking a can: the fist jerked up and down in front of the chest. */
const SHAKE_UP = new Vector3(0.8, 0.45, 0.55);
const SHAKE_DOWN = new Vector3(0.85, -0.6, 0.55);
/** Follow-through after a throw: straight out in front. */
const THROW_AIM = new Vector3(1, 0.05, 0.15);
/** Bowling a carried log: both arms swung back low, then out along the ground. */
const BOWL_WIND = new Vector3(-0.5, -0.85, 0.3);
const BOWL_THROUGH = new Vector3(0.95, -0.45, 0.2);
/** Lobbing it granny style: down between the knees, then up and out. */
const LOB_WIND = new Vector3(0.25, -1, -0.3);
const LOB_THROUGH = new Vector3(0.7, 0.75, 0.05);
/**
 * Carrying: both arms out in front and in towards each other. The arms are
 * short and the shoulders wide, so the hands only get so close.
 */
const CARRY_AIM = new Vector3(0.75, -0.2, -0.65);

// Climbing: the hand that is reaching, high above the head and in front, and the one that has
// just pulled (body space as above, for the right arm).
const CLIMB_HIGH = new Vector3(0.25, 0.97, 0.2);
const CLIMB_LOW = new Vector3(0.65, 0.45, 0.4);
/** Radians of the climbing cycle per metre climbed: one cycle is a couple of rungs. */
const CLIMB_STRIDE = 9;
/** How far the body is drawn in toward the rungs while climbing, metres: the sim keeps the (wide) collision box off them. */
const CLIMB_BODY_SHIFT = 0.3;

// Grip frames, in body space at the T-pose (right arm straight out along +Z).
/** A blade's shaft points forward and up out of the fist. */
const BLADE_REST_DIR = new Vector3(1, 0.6, 0).normalize();
/** Charged for a throw, the shaft points straight ahead whatever the arm does. */
const SPEAR_DIR = new Vector3(1, 0.08, 0).normalize();
/** A fishing rod drawn back for a cast points up and back over the shoulder. */
const ROD_BACK_DIR = new Vector3(-0.55, 0.8, 0.15).normalize();
/** A carried item sits this far above the hands, across the chest. */
const CARRY_LIFT = 0.08;
/**
 * A carried item is drawn bigger than on the first-person palm, so a log
 * spans the gap between the hands instead of floating in it.
 */
const CARRY_SCALE = 1.5;

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);

/**
 * Spring shoes. One shoe, as authored and not resized (ItemAssets.springShoe), is
 * snapped by the top face of its sole onto the bottom of each foot, and follows the
 * leg's swing. The springs hang below the foot, so the whole model is lifted by
 * their length while they are on: the springs stand on the ground, and the sim's
 * collision box (which does not change) is where the feet were.
 */
interface Shoe {
  readonly limb: Limb;
  readonly mesh: Object3D;
}

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
  /** Centre of the free end, where the hand is (limb geometry space). */
  readonly tip: Vector3;
  /** Pointing out of the joint along the limb (limb geometry space, unit). */
  readonly out: Vector3;
  /** The middle of the free end's bottom face: the sole of a foot (limb geometry space). */
  readonly sole: Vector3;
  /** The rotation this frame's pose gave the limb (limb geometry space). */
  readonly bend: Quaternion;
}

/** Swing cycle: slow raise, fast strike. 0..1 in, 0..1 out (1 = raised). */
function chopShape(p: number): number {
  if (p < 0.65) {
    const t = p / 0.65;
    return t * t * (3 - 2 * t);
  }
  const t = (p - 0.65) / 0.35;
  return 1 - t * t;
}

const blendDir = (out: Vector3, a: Vector3, b: Vector3, t: number): Vector3 =>
  out.copy(a).lerp(b, t).normalize();

// Scratch, reused every frame.
const qa = new Quaternion();
const qb = new Quaternion();
const qTilt = new Quaternion();
const qYaw = new Quaternion();
const tiltOffset = new Vector3();
const tiltEuler = new Euler();
const va = new Vector3();
const vb = new Vector3();
const vc = new Vector3();

export class PlayerModel {
  readonly root = new Group();

  /** Carries the ragball spin, pivoted at the torso's centre. */
  private readonly spin = new Group();
  /** Scale, and the offset that stands the model on the root. */
  private readonly fit = new Group();
  /** Model axes -> world axes. Everything under this is in model space. */
  private readonly orient = new Group();

  private readonly limbs: Limb[] = [];
  private readonly shoes: Shoe[] = [];
  /** How far the springs hang below the sole, metres: the lift while they are on. */
  private shoeDrop = 0;
  /** The spring shoes are on this frame. */
  private shoesOn = false;
  /** The arm on the character's right: the one that holds things. */
  private handArm: Limb | undefined;
  private offArm: Limb | undefined;

  /** In body space (under `spin`), at the right hand's grip, in metres. */
  private readonly holder = new Group();
  private readonly held: HeldItemSlot;
  private readonly throws = new ThrowWatcher();
  /**
   * Per limb, its geometry's axes to body space: the file's node rotation,
   * then the stand-up turn. Limb maths is in geometry space.
   */
  private readonly toBody = new Map<Limb, Quaternion>();
  private readonly fromBody = new Map<Limb, Quaternion>();
  /** Each arm's rest direction (straight out) in body space. */
  private readonly restOut = new Map<Limb, Vector3>();
  private readonly bladeRest = new Quaternion();
  private readonly spear = new Quaternion();
  private readonly rodBack = new Quaternion();
  /** The forward lunge of the throw under way, 0..1. */
  private lunge = 0;
  private readonly carryTurn = new Quaternion();
  private readonly aimRight = new Vector3();
  private readonly aimLeft = new Vector3();
  /** Each arm's final rotation this frame (limb geometry space). */
  private readonly armQuat = new Quaternion();
  private readonly offQuat = new Quaternion();

  private holdWeight = 0;
  private carryWeight = 0;
  private bladeWeight = 0;
  private chopWeight = 0;
  private chopPhase = 0;
  private scoopWeight = 0;
  private scoopPhase = 0;
  private chargeWeight = 0;
  private shakeWeight = 0;
  private shakePhase = 0;
  private bowlWeight = 0;
  private lobWeight = 0;
  private kick = 0;
  /** The wind-up the follow-through under way came out of. */
  private kickKind: AvatarAction = AvatarAction.Charge;

  private baseScale = 1;
  private baseLift = 0;
  /** Height of the torso's centre above the feet: the ragball pivot. */
  private pivotHeight = 0;
  private tuck = 0;
  /** How far the body follows the board rather than the look direction, 0..1. */
  private ride = 0;
  /** How side-on to the board the rider stands, 0 (facing along it) to 1. */
  private stance = 0;
  private phase = 0;
  private readonly rotation = new Quaternion();

  private constructor(
    private readonly scene: Scene,
    parts: Map<string, Mesh>,
    appearance: Appearance,
    items: HeldItemSources,
  ) {
    // Three turns stand the model up: one to bring the lateral axis onto
    // Z, one to lift the head off the floor, one to face +X, which is
    // where a yaw of zero points in the sim.
    const yAxis = new Vector3(0, 1, 0);
    const lateral = new Quaternion().setFromAxisAngle(yAxis, -Math.PI / 2);
    const stand = new Quaternion().setFromAxisAngle(
      new Vector3(0, 0, 1),
      -Math.PI / 2,
    );
    const face = new Quaternion().setFromAxisAngle(yAxis, -Math.PI / 2);
    this.orient.quaternion.copy(face.multiply(stand).multiply(lateral));

    const skin = litByBulbs(
      new MeshLambertNodeMaterial({ color: appearance.skin }),
    );
    const shirt = litByBulbs(
      new MeshLambertNodeMaterial({ color: appearance.shirt }),
    );

    // The torso and head were modelled facing the other way, so the belly
    // sat where the back belongs. Turning those two nodes about the standing
    // model's own vertical axis puts them the right way round; the limbs are
    // front-to-back symmetric and stay as they are.
    const up = new Vector3(0, 1, 0).applyQuaternion(
      this.orient.quaternion.clone().invert(),
    );
    const turnAround = new Quaternion().setFromAxisAngle(up, Math.PI);

    const box = new Box3();
    const pivot = new Vector3();
    let body: Mesh | undefined;

    for (const [name, mesh] of parts) {
      mesh.material = name === "body" ? shirt : skin;
      mesh.frustumCulled = false;
      mesh.geometry.computeBoundingBox();
      if (name === "body" || name === "head") {
        // Turn about the part's own centre, not the node origin, so it stays
        // exactly where the limbs expect it: the pivot is that centre, and
        // the translation puts it back after the rotation moves it.
        const centre = (mesh.geometry.boundingBox ?? new Box3()).getCenter(
          new Vector3(),
        );
        centre.applyQuaternion(mesh.quaternion);
        mesh.quaternion.premultiply(turnAround);
        mesh.position
          .copy(centre)
          .sub(centre.clone().applyQuaternion(turnAround));
      }
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
    this.fit.position.set(
      -center.x * this.baseScale,
      this.baseLift,
      -center.z * this.baseScale,
    );

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

    // Which arm is the right one is measured, not read off the part names:
    // the body was turned round on load, and the names are the artist's.
    for (const limb of this.limbs) {
      const toBody = this.orient.quaternion
        .clone()
        .multiply(limb.mesh.quaternion);
      this.toBody.set(limb, toBody);
      this.fromBody.set(limb, toBody.clone().invert());
      if (limb.axis !== 0) continue;
      const out = limb.out.clone().applyQuaternion(toBody);
      this.restOut.set(limb, out);
      if (out.z > 0) this.handArm = limb;
      else this.offArm = limb;
    }
    // At the T-pose the hand is unturned, so this is the blade's whole
    // grip; the arm's rotation is laid on top of it each frame.
    this.bladeRest.setFromUnitVectors(Z_AXIS, BLADE_REST_DIR);
    this.spear.setFromUnitVectors(Z_AXIS, SPEAR_DIR);
    this.rodBack.setFromUnitVectors(Z_AXIS, ROD_BACK_DIR);
    // Carry's long axis is +X; across the chest is body Z.
    this.carryTurn.setFromAxisAngle(Y_AXIS, -Math.PI / 2);

    this.spin.add(this.holder);
    this.held = new HeldItemSlot(this.holder, items);

    const shoeBounds = new Box3().setFromObject(items.assets.springShoe);
    this.shoeDrop = Math.max(0, -shoeBounds.min.y);
    for (const limb of this.limbs) {
      if (limb.axis !== 1) continue;
      const mesh = items.assets.springShoe.clone();
      mesh.visible = false;
      this.spin.add(mesh);
      this.shoes.push({ limb, mesh });
    }
  }

  static async load(
    scene: Scene,
    appearance: Appearance,
    items: HeldItemSources,
  ): Promise<PlayerModel> {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    const parts = new Map<string, Mesh>();
    gltf.scene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      // Before the constructor, which copies the limb data it deforms from.
      faceOutward(object.geometry);
      parts.set(object.name, object);
    });
    return new PlayerModel(scene, parts, appearance, items);
  }

  /** `dt` is a real frame delta: this is cosmetic, not part of the sim. */
  update(
    player: AvatarBody,
    pose: AvatarPose,
    dt: number,
    renderX: number,
    renderY: number,
    renderZ: number,
    /** How far the feet are lifted onto a board: the ground's angle is followed about the board's underside. */
    rideLift = 0,
  ): void {
    // A rider who has come off lies on the ground, not hovering at torso height.
    const ragball = player.mode === PlayerMode.Ragball;
    this.shoesOn = pose.held === ItemType.SpringShoes && !ragball;
    const rootY = renderY - player.skateTilt * (this.pivotHeight - 0.3) + (this.shoesOn ? this.shoeDrop : 0);
    this.root.position.set(renderX, rootY, renderZ);

    this.climbW += Math.min(1, dt * 10) * ((player.climbing && !ragball ? 1 : 0) - this.climbW);
    this.climbPhase = player.climb.travelled;
    const wall = player.climb.rail.horizontalNormal(this.wallScratch);
    if (this.climbW > 0.001) {
      this.root.position.x -= wall.x * CLIMB_BODY_SHIFT * this.climbW;
      this.root.position.z -= wall.z * CLIMB_BODY_SHIFT * this.climbW;
    }

    this.tuck +=
      Math.min(1, dt * RETRACT_RATE) * ((ragball ? 1 : 0) - this.tuck);

    // On a board the rider leans with it, onto the angle of the ground under the
    // wheels: about the board's lateral and long axes, the whole body as one.
    // Tilted about the point under the feet on the ground, not the body's centre.
    const lean = ragball ? 0 : this.ride;
    const pitch = player.skate.pitch * lean;
    const roll = player.skate.roll * lean;
    if (Math.abs(pitch) + Math.abs(roll) > 1e-4) {
      qYaw.setFromAxisAngle(Y_MODEL, -player.skate.heading);
      qTilt.setFromEuler(tiltEuler.set(roll, 0, pitch, "ZYX"));
      qTilt.premultiply(qYaw);
      qYaw.invert();
      qTilt.multiply(qYaw);
      this.root.quaternion.copy(qTilt);
      tiltOffset.set(0, rootY - (renderY - rideLift), 0).applyQuaternion(qTilt);
      this.root.position.set(renderX + tiltOffset.x, renderY - rideLift + tiltOffset.y, renderZ + tiltOffset.z);
    } else {
      this.root.quaternion.identity();
    }

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
      // Facing the look direction; on a board, the board's heading with the
      // body turned side-on to it, square to it again while pushing. A bail
      // tips the body over backwards about its own lateral axis.
      const look = Math.atan2(player.frontZ, player.frontX);
      const ride = player.skating ? 1 : 0;
      this.ride += Math.min(1, dt * 10) * (ride - this.ride);
      const stanceTarget = player.skating && !player.skate.pushing ? 1 : 0;
      this.stance += Math.min(1, dt * 9) * (stanceTarget - this.stance);
      const riding = player.skate.heading + this.stance * (Math.PI / 2);
      let facing = look;
      if (this.ride > 0.001) {
        const turn = riding - look;
        facing =
          look +
          (turn - Math.PI * 2 * Math.round(turn / (Math.PI * 2))) * this.ride;
      }
      if (this.climbW > 0.001) {
        // Facing the rungs, not the camera: the head turns freely, the body does not.
        const turn = Math.atan2(-wall.z, -wall.x) - facing;
        facing += (turn - Math.PI * 2 * Math.round(turn / (Math.PI * 2))) * this.climbW;
      }
      this.spin.rotation.set(0, -facing, player.skateTilt * 1.5);
    }

    const speed = Math.hypot(player.vx, player.vz);
    this.phase += dt * WALK_CYCLE_SPEED * Math.min(1, speed / player.walkSpeed);
    // On a board there is no stride: the legs only move to push, and the arms pump with them.
    const riding = player.skating && !ragball;
    const gait = player.grounded && !riding ? Math.min(1, speed / 2) : 0;
    const walkSwing = riding
      ? player.skate.pushPhase > 0
        ? Math.sin(player.skate.pushPhase * Math.PI * 2) * 0.8
        : 0
      : player.grounded
        ? Math.sin(this.phase) * gait * 0.7
        : 0.3;
    // Climbing: the legs step up the rungs one after the other.
    const swing = walkSwing + (Math.sin(this.climbPhase * CLIMB_STRIDE) * 0.8 - walkSwing) * this.climbW;
    const active = 1 - this.tuck;

    // Two bounces per stride, one per footfall.
    this.fit.position.y =
      this.baseLift -
      this.pivotHeight +
      Math.abs(Math.sin(this.phase)) * BOUNCE_HEIGHT * gait * active;

    this.updateHands(pose, dt, active);

    // An arm lies along the lateral axis, so it swings forward about model
    // X; a leg hangs along +X, so it swings about model Y. One angle
    // serves both arms, which point opposite ways to begin with.
    for (const limb of this.limbs) {
      const angle =
        limb.axis === 0
          ? swing * active + this.tuck * 2.2
          : swing * limb.sign * active - this.tuck * 2.3;
      qa.setFromAxisAngle(limb.axis === 0 ? X_MODEL : Y_MODEL, angle);
      // A posed arm leaves the walk for the pose, by how posed it is.
      const posed =
        limb === this.handArm
          ? this.rightPose
          : limb === this.offArm
            ? this.leftPose
            : 0;
      if (posed > 0) {
        const aim = limb === this.handArm ? this.aimRight : this.aimLeft;
        this.armRotation(limb, aim, qb);
        qa.slerp(qb, posed);
      }
      deformLimb(limb, qa, this.tuck);
      limb.bend.copy(qa);
      if (limb === this.handArm) this.armQuat.copy(qa);
      else if (limb === this.offArm) this.offQuat.copy(qa);
    }

    this.placeHolder(pose);
    this.placeShoes();
  }

  /** Puts each shoe's sole on the bottom of its foot, turned with the leg. */
  private placeShoes(): void {
    for (const shoe of this.shoes) {
      const shown = this.shoesOn && this.tuck < 0.3;
      shoe.mesh.visible = shown;
      if (!shown) continue;
      const toBody = this.toBody.get(shoe.limb);
      const fromBody = this.fromBody.get(shoe.limb);
      if (toBody === undefined || fromBody === undefined) continue;
      this.handPoint(shoe.limb, shoe.limb.bend, shoe.mesh.position, shoe.limb.sole);
      shoe.mesh.quaternion.copy(shoe.limb.bend).premultiply(toBody).multiply(fromBody);
    }
  }

  /** How far each arm is in its action pose rather than the walk, 0..1. */
  private rightPose = 0;
  private leftPose = 0;
  /** How far into climbing the body is, 0..1, and how far up it has climbed (the cycle's phase). */
  private climbW = 0;
  private climbPhase = 0;
  private readonly wallScratch = { x: 0, z: 0 };

  /**
   * Advances the action cycles and works out where each arm points. The
   * order is the same as the first-person arm's: hold, then whichever
   * action is under way on top.
   */
  private updateHands(pose: AvatarPose, dt: number, active: number): void {
    const rate = Math.min(1, dt * 12);
    const style = this.held.show(pose.held);
    const chopping = pose.action === AvatarAction.Chup;
    const scooping = pose.action === AvatarAction.Scoop;
    const charge =
      pose.action === AvatarAction.Charge || pose.action === AvatarAction.Put
        ? pose.charge
        : 0;

    this.holdWeight +=
      rate * ((style === HoldStyle.Empty ? 0 : 1) - this.holdWeight);
    this.carryWeight +=
      rate * ((style === HoldStyle.Carry ? 1 : 0) - this.carryWeight);
    this.bladeWeight +=
      rate * ((style === HoldStyle.Blade ? 1 : 0) - this.bladeWeight);
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
    const swing = this.kick > 0 ? Math.sin(this.kick * Math.PI) : 0;
    const lunge =
      this.kickKind === AvatarAction.Charge ||
      this.kickKind === AvatarAction.Put
        ? swing
        : 0;
    this.lunge = lunge;
    const bowlThrough = this.kickKind === AvatarAction.Bowl ? swing : 0;
    const lobThrough = this.kickKind === AvatarAction.Lob ? swing : 0;
    // Bowl and lob are two-handed: both arms take them.
    const both = Math.max(
      this.bowlWeight,
      this.lobWeight,
      bowlThrough,
      lobThrough,
    );

    const raised = chopShape(this.chopPhase);
    // Scoop: 0 -> dipped, 0.5 -> scooped, 1 -> lifted, as in first person.
    const sp = this.scoopPhase * Math.PI * 2;
    const dip = 0.5 - 0.5 * Math.cos(sp);
    const lift = Math.max(0, Math.sin(sp - 0.6));

    // Right arm.
    const aim = this.aimRight.copy(HOLD_AIM);
    blendDir(aim, aim, mirror(va, CARRY_AIM, 1), this.carryWeight);
    // The chup: a karate chop empty-handed, a slash with a blade.
    blendDir(vb, CHUP_STRUCK, CHUP_RAISED, raised);
    blendDir(vc, SLASH_STRUCK, SLASH_RAISED, raised);
    blendDir(vb, vb, vc, this.bladeWeight);
    blendDir(aim, aim, vb, this.chopWeight);
    blendDir(vb, SCOOP_UP, SCOOP_DOWN, dip * (1 - lift));
    blendDir(aim, aim, vb, this.scoopWeight);
    blendDir(aim, aim, CHARGE_AIM, this.chargeWeight);
    blendDir(vb, SHAKE_DOWN, SHAKE_UP, 0.5 + 0.5 * Math.sin(this.shakePhase * Math.PI * 2));
    blendDir(aim, aim, vb, this.shakeWeight);
    blendDir(aim, aim, THROW_AIM, lunge);
    this.logThrow(aim, 1, bowlThrough, lobThrough);

    // Climbing: the hands take the rungs by turns, over the head.
    const reach = 0.5 + 0.5 * Math.sin(this.climbPhase * CLIMB_STRIDE);
    blendDir(vb, CLIMB_LOW, CLIMB_HIGH, reach);
    blendDir(aim, aim, vb, this.climbW);

    // Left arm: only two-handed things move it.
    const left = mirror(this.aimLeft, CARRY_AIM, -1);
    blendDir(vb, CLIMB_LOW, CLIMB_HIGH, 1 - reach);
    blendDir(left, left, mirror(va, vb, -1), this.climbW);
    blendDir(vb, SCOOP_UP, SCOOP_DOWN, dip * (1 - lift));
    blendDir(left, left, mirror(vb, vb, -1), this.scoopWeight);
    this.logThrow(left, -1, bowlThrough, lobThrough);

    this.rightPose =
      Math.max(
        this.holdWeight,
        this.chopWeight,
        this.scoopWeight,
        this.chargeWeight,
        this.shakeWeight,
        lunge,
        both,
        this.climbW,
      ) * active;
    this.leftPose = Math.max(this.carryWeight, this.scoopWeight, both, this.climbW) * active;
  }

  /** Lays the bowl and lob wind-ups and follow-throughs onto one arm's aim. */
  private logThrow(
    aim: Vector3,
    side: number,
    bowlThrough: number,
    lobThrough: number,
  ): void {
    blendDir(aim, aim, mirror(va, BOWL_WIND, side), this.bowlWeight);
    blendDir(aim, aim, mirror(va, LOB_WIND, side), this.lobWeight);
    blendDir(aim, aim, mirror(va, BOWL_THROUGH, side), bowlThrough);
    blendDir(aim, aim, mirror(va, LOB_THROUGH, side), lobThrough);
  }

  /**
   * The rotation (limb geometry space) that turns `limb` from its rest to
   * point along `aim` (body space).
   */
  private armRotation(limb: Limb, aim: Vector3, out: Quaternion): Quaternion {
    const rest = this.restOut.get(limb) ?? Z_AXIS;
    out.setFromUnitVectors(rest, aim);
    // Body-space rotation R_b becomes G^-1 R_b G in geometry space.
    return out
      .premultiply(this.fromBody.get(limb) ?? qb.identity())
      .multiply(this.toBody.get(limb) ?? qb.identity());
  }

  /** Puts the holder at the right hand, turned for the held item's style. */
  private placeHolder(pose: AvatarPose): void {
    const arm = this.handArm;
    const style = this.held.show(pose.held, false);
    const shown =
      arm !== undefined && style !== HoldStyle.Empty && this.tuck < 0.3 && this.climbW < 0.4;
    // A thrown stick or log is out of the hand for the start of the follow-through.
    const throwable =
      (style === HoldStyle.Blade ||
        style === HoldStyle.Carry ||
        style === HoldStyle.Ball) &&
      leavesHandOnThrow(pose.held);
    this.held.show(pose.held, shown && (!throwable || this.kick <= 0.35));
    if (!shown) return;

    this.handPoint(arm, this.armQuat, this.holder.position);
    // Body-space turn of the hand: G R G^-1.
    const toBody = this.toBody.get(arm);
    const fromBody = this.fromBody.get(arm);
    if (toBody === undefined || fromBody === undefined) return;
    qa.copy(this.armQuat).premultiply(toBody).multiply(fromBody);

    if (style === HoldStyle.Carry && this.offArm !== undefined) {
      // Between the hands, resting on them, across the chest.
      this.handPoint(this.offArm, this.offQuat, va);
      this.holder.position.lerp(va, 0.5 * this.carryWeight);
      this.holder.position.y += CARRY_LIFT;
      this.holder.quaternion.copy(this.carryTurn);
      this.holder.scale.setScalar(CARRY_SCALE);
      return;
    }
    this.holder.scale.setScalar(1);
    if (style === HoldStyle.Blade) {
      this.holder.quaternion
        .copy(qa)
        .multiply(this.bladeRest)
        .slerp(pose.held === ItemType.FishingRod ? this.rodBack : this.spear, this.chargeWeight);
      // A cast whips the rod forward as it is let go.
      if (pose.held === ItemType.FishingRod) this.holder.quaternion.slerp(this.spear, this.lunge);
    } else {
      this.holder.quaternion.copy(qa);
    }
    this.held.settleRod(this.chargeWeight < 0.02 && this.lunge < 0.02);
  }

  /** The limb's free end after `rotation` (geometry space), in body space. */
  private handPoint(limb: Limb, rotation: Quaternion, out: Vector3, at: Vector3 = limb.tip): Vector3 {
    out.set(at.x - limb.pivotX, at.y - limb.pivotY, at.z - limb.pivotZ);
    out.applyQuaternion(rotation);
    out.x += limb.pivotX;
    out.y += limb.pivotY;
    out.z += limb.pivotZ;
    // Geometry -> orient (the node's own transform) -> body.
    out.applyQuaternion(limb.mesh.quaternion).add(limb.mesh.position);
    out
      .applyQuaternion(this.orient.quaternion)
      .multiplyScalar(this.baseScale)
      .add(this.fit.position);
    return out;
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  /** A named point on the item in the hand (the fishing rod's line tip), for the line to start from. */
  heldAnchor(name: string): Object3D | undefined {
    return this.held.anchor(name);
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}

const X_MODEL = new Vector3(1, 0, 0);
const Y_MODEL = new Vector3(0, 1, 0);

/** `v` with Z multiplied by `sign`: a right-arm pose for the left arm. */
function mirror(out: Vector3, v: Vector3, sign: number): Vector3 {
  return out.set(v.x, v.y, v.z * sign);
}

function buildLimb(
  mesh: Mesh,
  pivot: Vector3,
  isArm: boolean,
  left: boolean,
): Limb {
  const position = mesh.geometry.getAttribute("position") as BufferAttribute;
  const normal = mesh.geometry.getAttribute("normal") as
    BufferAttribute | undefined;
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

  // The hand (or foot) is the middle of the last stretch of the limb.
  const tip = new Vector3();
  let tipCount = 0;
  for (let i = 0; i < count; i++) {
    const dx = (basePositions[i * 3] ?? 0) - pivot.x;
    const dy = (basePositions[i * 3 + 1] ?? 0) - pivot.y;
    if (dx * outX + dy * outY < reach * 0.85) continue;
    tip.x += basePositions[i * 3] ?? 0;
    tip.y += basePositions[i * 3 + 1] ?? 0;
    tip.z += basePositions[i * 3 + 2] ?? 0;
    tipCount++;
  }
  if (tipCount > 0) tip.divideScalar(tipCount);
  else tip.set(pivot.x + outX * reach, pivot.y + outY * reach, pivot.z);

  const sole = tip.clone();
  if (!isArm) sole.x = pivot.x + reach;

  return {
    mesh,
    basePositions,
    baseNormals:
      normal === undefined
        ? undefined
        : new Float32Array(normal.array as Float32Array),
    weights,
    pivotX: pivot.x,
    pivotY: pivot.y,
    pivotZ: pivot.z,
    axis: isArm ? 0 : 1,
    sign: left ? 1 : -1,
    tip,
    out: new Vector3(outX, outY, 0),
    sole,
    bend: new Quaternion(),
  };
}

/**
 * Bends the limb by `rotation` about its joint, each vertex by its weight's
 * share of the angle (Rodrigues' formula about the rotation's own axis), so
 * the joint end stays put and the free end takes the whole turn.
 */
function deformLimb(limb: Limb, rotation: Quaternion, tuck: number): void {
  const geometry = limb.mesh.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute;
  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  const out = position.array as Float32Array;
  const outNormal = normal?.array as Float32Array | undefined;
  const base = limb.basePositions;
  const baseNormals = limb.baseNormals;
  const weights = limb.weights;

  // Axis-angle of the rotation, the short way round.
  const flip = rotation.w < 0 ? -1 : 1;
  const w = Math.min(1, rotation.w * flip);
  const angle = 2 * Math.acos(w);
  const sinHalf = Math.sqrt(Math.max(0, 1 - w * w));
  const kx = sinHalf > 1e-6 ? (rotation.x * flip) / sinHalf : 1;
  const ky = sinHalf > 1e-6 ? (rotation.y * flip) / sinHalf : 0;
  const kz = sinHalf > 1e-6 ? (rotation.z * flip) / sinHalf : 0;

  for (let i = 0; i < weights.length; i++) {
    const wt = weights[i] ?? 0;
    const a = angle * wt;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const t = 1 - c;
    const o = i * 3;

    const x = (base[o] ?? 0) - limb.pivotX;
    const y = (base[o + 1] ?? 0) - limb.pivotY;
    const z = (base[o + 2] ?? 0) - limb.pivotZ;
    const dot = kx * x + ky * y + kz * z;
    const rx = x * c + (ky * z - kz * y) * s + kx * dot * t;
    const ry = y * c + (kz * x - kx * z) * s + ky * dot * t;
    const rz = z * c + (kx * y - ky * x) * s + kz * dot * t;

    // Tucking draws the limb in towards its own joint by the same weight,
    // so the shoulder and hip stay exactly where they are.
    const pull = 1 - tuck * TUCK_SHRINK * wt;
    out[o] = limb.pivotX + rx * pull;
    out[o + 1] = limb.pivotY + ry * pull;
    out[o + 2] = limb.pivotZ + rz * pull;

    if (baseNormals !== undefined && outNormal !== undefined) {
      const nx = baseNormals[o] ?? 0;
      const ny = baseNormals[o + 1] ?? 0;
      const nz = baseNormals[o + 2] ?? 0;
      const nd = kx * nx + ky * ny + kz * nz;
      outNormal[o] = nx * c + (ky * nz - kz * ny) * s + kx * nd * t;
      outNormal[o + 1] = ny * c + (kz * nx - kx * nz) * s + ky * nd * t;
      outNormal[o + 2] = nz * c + (kx * ny - ky * nx) * s + kz * nd * t;
    }
  }

  position.needsUpdate = true;
  if (normal !== undefined) normal.needsUpdate = true;
}
