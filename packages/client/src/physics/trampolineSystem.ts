import type { Object3D, Scene } from "three/webgpu";

import {
  TRAMPOLINE_RESTITUTION,
  type Trampoline,
  type TrampolineField,
} from "@fgp/shared/items/trampoline";

import type { ItemAssets } from "../render/itemAssets.ts";
import type { PhysicsWorld } from "./physicsWorld.ts";

/**
 * Everything the trampoline field needs on the client that is not its rules:
 * a mesh per mat in the scene, and a static body per mat in the rigid-body
 * world so logs rebound off it.
 *
 * The field is the truth. This only mirrors it, each frame, so a mat placed
 * before Jolt's WASM has loaded gets its body as soon as it has.
 */
export class TrampolineSystem {
  private readonly objects = new Map<number, Object3D>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
    private readonly field: TrampolineField,
  ) {}

  sync(physics: PhysicsWorld | undefined): void {
    for (const id of this.field.removed) {
      const object = this.objects.get(id);
      if (object !== undefined) this.scene.remove(object);
      this.objects.delete(id);
      physics?.removePlacedCylinder(id);
    }
    this.field.removed.length = 0;

    for (const item of this.field.items) {
      if (!this.objects.has(item.id)) this.add(item);
      if (physics !== undefined && !physics.hasPlacedCylinder(item.id)) {
        const { body } = item;
        physics.setPlacedCylinder(
          item.id,
          body.x,
          body.y,
          body.z,
          body.radius,
          body.halfHeight,
          TRAMPOLINE_RESTITUTION,
        );
      }
    }
  }

  private add(item: Trampoline): void {
    const object = this.assets.trampoline.clone();
    object.position.set(item.x, item.topY, item.z);
    this.scene.add(object);
    this.objects.set(item.id, object);
  }

  clear(physics: PhysicsWorld | undefined): void {
    for (const [id, object] of this.objects) {
      this.scene.remove(object);
      physics?.removePlacedCylinder(id);
    }
    this.objects.clear();
  }
}
