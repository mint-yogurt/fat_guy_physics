import {
  Box3,
  Group,
  Matrix4,
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
 * The model authors each limb as its own node (arm_left/arm_right/body/
 * head/leg_left/leg_right) specifically so they can be animated, so this
 * hangs each limb off a pivot group placed at the top of that limb's own
 * bounding box -- the shoulder or hip -- and rotates the group. The same
 * groups fold inward for Ragball rather than there being a second model.
 *
 * The source is Z-up with +X forward, which is Blender's convention and
 * not three's; geometry is rotated into Y-up once at load, after which +X
 * is still forward and matches the sim's yaw of zero.
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
  /** +1 for the left side, -1 for the right. */
  readonly sign: number;
}

export class PlayerModel {
  readonly root = new Group();

  private readonly body = new Group();
  private readonly arms: Limb[] = [];
  private readonly legs: Limb[] = [];

  private tuck = 0;
  private phase = 0;
  private readonly rotation = new Quaternion();

  private constructor(
    private readonly scene: Scene,
    parts: Map<string, Mesh>,
    appearance: Appearance,
  ) {
    const skin = new MeshLambertMaterial({ color: appearance.skin });
    const shirt = new MeshLambertMaterial({ color: appearance.shirt });

    // The exported basis is not three's: measured off the parts, head-to-toe
    // runs along -X, left-to-right along +Y, and the belly points -Z. This
    // maps that onto three's Y-up with +X forward, which is also the sim's
    // yaw of zero. Baked into the geometry rather than left on a parent
    // transform, so limb pivots are computed in the space the animation
    // runs in.
    // prettier-ignore
    const toYUp = new Matrix4().set(
      0, 0, -1, 0,
      -1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 0, 1,
    );
    const bounds = new Box3();
    for (const mesh of parts.values()) {
      mesh.geometry.applyMatrix4(toYUp);
      mesh.geometry.computeBoundingBox();
      bounds.union(mesh.geometry.boundingBox ?? new Box3());
    }

    // Scaled to the collision capsule's height and dropped so the feet sit
    // at the root, which is the sim's position.
    const size = new Vector3();
    bounds.getSize(size);
    const scale = size.y > 0 ? WALK_HEIGHT / size.y : 1;
    const lift = -bounds.min.y;

    const pivot = new Vector3();
    const box = new Box3();

    for (const [name, mesh] of parts) {
      mesh.geometry.translate(0, lift, 0);
      mesh.geometry.scale(scale, scale, scale);
      mesh.material = name === "body" ? shirt : skin;
      mesh.frustumCulled = false;

      const isLimb = name.startsWith("arm") || name.startsWith("leg");
      if (!isLimb) {
        this.body.add(mesh);
        continue;
      }

      mesh.geometry.computeBoundingBox();
      box.copy(mesh.geometry.boundingBox ?? new Box3());
      box.getCenter(pivot);
      const left = name.endsWith("left");
      // Hips are the top of the leg; shoulders are the *inner* end of the
      // arm, because the arms are stubby cylinders held out from the body
      // rather than hanging down -- pivoting them at the top would swing
      // them from the wrong end.
      pivot.y = box.max.y;
      if (name.startsWith("arm")) pivot.z = left ? box.min.z : box.max.z;

      const group = new Group();
      group.position.copy(pivot);
      mesh.geometry.translate(-pivot.x, -pivot.y, -pivot.z);
      group.add(mesh);
      this.body.add(group);

      const limb: Limb = { group, sign: left ? 1 : -1 };
      (name.startsWith("arm") ? this.arms : this.legs).push(limb);
    }

    this.root.add(this.body);
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
      // The model faces +X and a yaw of zero means +X, so the rotation
      // about Y is the negated yaw (three turns +X towards -Z).
      this.root.quaternion.identity();
      this.root.rotation.set(0, -player.yaw, 0);
    }

    const speed = Math.hypot(player.vx, player.vz);
    this.phase += dt * WALK_CYCLE_SPEED * Math.min(1, speed / player.walkSpeed);
    const swing = player.grounded ? Math.sin(this.phase) * Math.min(1, speed / 2) * 0.7 : 0.35;

    // An arm points along the lateral axis, so swinging it forward is a
    // rotation about Y -- and one angle serves both arms, since the two
    // point opposite ways and so move opposite ways. A leg hangs down the
    // Y axis, so its forward swing is a rotation about Z, which does need
    // the per-side sign.
    for (const limb of this.arms) {
      limb.group.rotation.y = -swing * (1 - this.tuck);
      limb.group.scale.setScalar(1 - this.tuck * 0.7);
    }
    for (const limb of this.legs) {
      limb.group.rotation.z = swing * limb.sign * (1 - this.tuck);
      limb.group.scale.setScalar(1 - this.tuck * 0.7);
    }

    // Curl down so the tucked silhouette sits on the collision sphere
    // rather than standing on top of it.
    this.body.position.y = -this.tuck * 0.35;
    this.body.scale.setScalar(1 - this.tuck * 0.2);
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}
