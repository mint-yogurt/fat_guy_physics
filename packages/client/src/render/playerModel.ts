import {
  BoxGeometry,
  Group,
  Mesh,
  MeshLambertMaterial,
  Quaternion,
  type Scene,
} from "three/webgpu";

import { PlayerMode, type Player } from "@fgp/shared/sim/player";

/**
 * The player character: boxes, built in code, one half mirrored to the
 * other -- which is the model the design asks for and avoids an asset
 * pipeline for a shape this simple.
 *
 * Limbs hang off pivot groups at the shoulder/hip so the walk cycle is two
 * sine waves, and so Ragball can retract them into the torso by scaling and
 * folding the same groups rather than swapping to a second model.
 */

export interface Appearance {
  name: string;
  skin: string;
  shirt: string;
  /** 0-2: brow/eye arrangement. */
  face: number;
}

export const DEFAULT_APPEARANCE: Appearance = {
  name: "fat guy",
  skin: "#d9a06a",
  shirt: "#2f6fb0",
  face: 0,
};

const WALK_CYCLE_SPEED = 7;
const RETRACT_RATE = 9;

function box(w: number, h: number, d: number, material: MeshLambertMaterial): Mesh {
  return new Mesh(new BoxGeometry(w, h, d), material);
}

export class PlayerModel {
  readonly root = new Group();

  private readonly skinMaterial: MeshLambertMaterial;
  private readonly shirtMaterial: MeshLambertMaterial;
  private readonly eyeMaterial = new MeshLambertMaterial({ color: 0x1b1b22 });

  private readonly body = new Group();
  private readonly arms: Group[] = [];
  private readonly legs: Group[] = [];
  private readonly head: Mesh;

  /** 0 = standing, 1 = fully tucked into the ball. */
  private tuck = 0;
  private phase = 0;
  private readonly rotation = new Quaternion();

  constructor(scene: Scene, appearance: Appearance) {
    this.skinMaterial = new MeshLambertMaterial({ color: appearance.skin });
    this.shirtMaterial = new MeshLambertMaterial({ color: appearance.shirt });

    const torso = box(0.52, 0.62, 0.34, this.shirtMaterial);
    torso.position.y = 1.15;
    this.body.add(torso);

    this.head = box(0.34, 0.32, 0.32, this.skinMaterial);
    this.head.position.y = 1.62;
    this.body.add(this.head);

    // The face is drawn on the half we build, then mirrored with it.
    const browDrop = appearance.face === 1 ? 0.03 : 0;
    const eyeGap = appearance.face === 2 ? 0.11 : 0.08;

    // One side, then mirrored: side = +1 is the half that is authored.
    for (const side of [1, -1]) {
      const eye = box(0.05, 0.06 - browDrop, 0.02, this.eyeMaterial);
      eye.position.set(side * eyeGap, 1.66 - browDrop, -0.165);
      this.body.add(eye);

      const arm = new Group();
      arm.position.set(side * 0.33, 1.42, 0);
      const upper = box(0.14, 0.52, 0.16, this.shirtMaterial);
      upper.position.y = -0.26;
      const hand = box(0.14, 0.14, 0.16, this.skinMaterial);
      hand.position.y = -0.58;
      arm.add(upper, hand);
      this.body.add(arm);
      this.arms.push(arm);

      const leg = new Group();
      leg.position.set(side * 0.14, 0.84, 0);
      const thigh = box(0.18, 0.84, 0.2, this.skinMaterial);
      thigh.position.y = -0.42;
      leg.add(thigh);
      this.body.add(leg);
      this.legs.push(leg);
    }

    this.root.add(this.body);
    scene.add(this.root);
  }

  /** `dt` is a real frame delta; this is cosmetic and not part of the sim. */
  update(player: Player, dt: number, renderX: number, renderY: number, renderZ: number): void {
    this.root.position.set(renderX, renderY, renderZ);

    const ragball = player.mode === PlayerMode.Ragball;
    const target = ragball ? 1 : 0;
    this.tuck += Math.min(1, dt * RETRACT_RATE) * (target - this.tuck);

    if (ragball) {
      // The sim already tracks the ball's rolling orientation; the body
      // just rides it, curled up.
      this.rotation.set(
        player.orientationX,
        player.orientationY,
        player.orientationZ,
        player.orientationW,
      );
      this.root.quaternion.copy(this.rotation);
    } else {
      this.root.rotation.set(0, player.yaw, 0);
    }

    const speed = Math.hypot(player.vx, player.vz);
    this.phase += dt * WALK_CYCLE_SPEED * Math.min(1, speed / player.walkSpeed);
    const swing = player.grounded ? Math.sin(this.phase) * Math.min(1, speed / 2) * 0.7 : 0.35;

    for (let i = 0; i < 2; i++) {
      const sign = i === 0 ? 1 : -1;
      const arm = this.arms[i];
      const leg = this.legs[i];
      if (arm === undefined || leg === undefined) continue;

      // Retracting: limbs rotate up into the torso and shrink, so the
      // silhouette becomes the collision sphere rather than a man-shape
      // spinning end over end.
      arm.rotation.x = swing * sign * (1 - this.tuck) + this.tuck * 2.4;
      leg.rotation.x = -swing * sign * (1 - this.tuck) + this.tuck * -2.5;
      const scale = 1 - this.tuck * 0.55;
      arm.scale.setScalar(scale);
      leg.scale.setScalar(scale);
    }

    // Curl the whole body down towards the ball's centre.
    this.body.position.y = -this.tuck * 0.72;
    this.head.position.y = 1.62 - this.tuck * 0.42;
  }

  set visible(value: boolean) {
    this.root.visible = value;
  }

  dispose(scene: Scene): void {
    scene.remove(this.root);
  }
}
