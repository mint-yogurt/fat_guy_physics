import {
  Box3,
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
 * Nothing here modifies the model's geometry -- no baked rotations, no
 * re-centred vertices. The file's parts are already in the right places
 * relative to each other (a T-pose), so every transform is on an Object3D:
 * parent groups orient and scale the whole model, and each limb is
 * re-parented to a group sitting at its joint with the mesh offset back by
 * the same amount. Rewriting the vertex data instead is what broke the
 * normals and threw the limbs off the body the first time.
 *
 * Axes, measured off the exported part bounds rather than assumed: the
 * model's own up is -X, its lateral axis is Y, and it faces -Z. The limb
 * rotations below are written in those axes, because the limbs live inside
 * the group that does the fixing up.
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

interface Limb {
  readonly group: Group;
  /** +1 left, -1 right. */
  readonly sign: number;
}

export class PlayerModel {
  readonly root = new Group();

  /** Scale, and the offset that stands the model on the root. */
  private readonly fit = new Group();
  /** Model axes -> world axes. Everything under this is in model space. */
  private readonly orient = new Group();

  private readonly arms: Limb[] = [];
  private readonly legs: Limb[] = [];

  private baseScale = 1;
  private tuck = 0;
  private phase = 0;
  private readonly rotation = new Quaternion();

  private constructor(
    private readonly scene: Scene,
    parts: Map<string, Mesh>,
    appearance: Appearance,
  ) {
    // -X is up, so stand it on +Y, then turn it to face +X, which is where
    // a yaw of zero points in the sim. Composed explicitly rather than as
    // an Euler triple: the order an Euler applies its axes in is the easy
    // thing to get backwards, and backwards here lays the model on its
    // side.
    const stand = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2);
    const face = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), -Math.PI / 2);
    this.orient.quaternion.copy(face.multiply(stand));

    const skin = new MeshLambertMaterial({ color: appearance.skin });
    const shirt = new MeshLambertMaterial({ color: appearance.shirt });

    const box = new Box3();
    const pivot = new Vector3();

    for (const [name, mesh] of parts) {
      mesh.material = name === "body" ? shirt : skin;
      mesh.frustumCulled = false;
      mesh.geometry.computeBoundingBox();

      const isArm = name.startsWith("arm");
      if (!isArm && !name.startsWith("leg")) {
        this.orient.add(mesh);
        continue;
      }

      box.copy(mesh.geometry.boundingBox ?? new Box3());
      box.getCenter(pivot);
      const left = name.endsWith("left");
      if (isArm) {
        // Shoulder: the end of the arm nearest the body along the lateral
        // axis, since the arms are held out in the T-pose.
        pivot.y = left ? box.min.y : box.max.y;
      } else {
        // Hip: the top of the leg, and up is -X.
        pivot.x = box.min.x;
      }

      const group = new Group();
      group.position.copy(pivot);
      mesh.position.copy(pivot).negate();
      group.add(mesh);
      this.orient.add(group);
      (isArm ? this.arms : this.legs).push({ group, sign: left ? 1 : -1 });
    }

    // Measured after orienting, so "height" means height.
    this.fit.add(this.orient);
    const bounds = new Box3().setFromObject(this.fit);
    const size = new Vector3();
    bounds.getSize(size);
    this.baseScale = size.y > 0 ? WALK_HEIGHT / size.y : 1;
    this.fit.scale.setScalar(this.baseScale);
    this.fit.position.y = -bounds.min.y * this.baseScale;

    this.root.add(this.fit);
    scene.add(this.root);
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
      this.root.quaternion.copy(this.rotation);
    } else {
      this.root.quaternion.identity();
      // Taken from the front vector rather than player.yaw, which is in
      // degrees -- feeding those to a radians rotation is what had the
      // model lying on its side. Facing is +X after orienting, and three
      // turns +X towards -Z, hence the negation.
      this.root.rotation.set(0, -Math.atan2(player.frontZ, player.frontX), 0);
    }

    const speed = Math.hypot(player.vx, player.vz);
    this.phase += dt * WALK_CYCLE_SPEED * Math.min(1, speed / player.walkSpeed);
    const swing = player.grounded ? Math.sin(this.phase) * Math.min(1, speed / 2) * 0.7 : 0.3;
    const active = 1 - this.tuck;

    // Model space faces -Z, so a limb swings forward about whichever axis
    // moves its far end that way: X for an arm, which lies along the
    // lateral axis, and Y for a leg, which hangs along +X. One angle
    // serves both arms, since they point opposite ways to begin with.
    for (const limb of this.arms) {
      limb.group.rotation.x = swing * active;
      limb.group.scale.setScalar(1 - this.tuck * 0.7);
    }
    for (const limb of this.legs) {
      limb.group.rotation.y = swing * limb.sign * active;
      limb.group.scale.setScalar(1 - this.tuck * 0.7);
    }

    this.fit.scale.setScalar(this.baseScale * (1 - this.tuck * 0.2));
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}
