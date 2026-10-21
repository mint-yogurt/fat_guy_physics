import type { Object3D, Scene } from "three/webgpu";

import { ItemType } from "@fgp/shared/items/inventory";
import type { FlyingVessel } from "@fgp/shared/items/vessel";

import type { ItemAssets } from "./itemAssets.ts";

/**
 * Cans and balls of goo in the air: the item's own mesh, tumbling as it goes.
 * Drawn between substeps like the rest. What they burst into is not here (see
 * `GooStains` in gooMaterial.ts and the sprays in main.ts).
 */

/** Radians per second a thrown one turns about each axis. */
const TUMBLE_X = 13;
const TUMBLE_Z = 8;

export class VesselsView {
  private readonly views = new Map<FlyingVessel, Object3D>();
  private readonly seen = new Set<FlyingVessel>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
  ) {}

  sync(flying: readonly FlyingVessel[], alpha: number): void {
    this.seen.clear();
    for (const body of flying) {
      this.seen.add(body);
      let view = this.views.get(body);
      if (view === undefined) {
        view = (body.spec.item === ItemType.MountainLightning ? this.assets.mountainLightning : this.assets.gooBall).clone();
        view.traverse((child) => {
          child.frustumCulled = false;
        });
        this.scene.add(view);
        this.views.set(body, view);
      }
      view.position.set(
        body.prevX + (body.x - body.prevX) * alpha,
        body.prevY + (body.y - body.prevY) * alpha,
        body.prevZ + (body.z - body.prevZ) * alpha,
      );
      view.rotation.set(body.age * TUMBLE_X, 0, body.age * TUMBLE_Z);
    }
    for (const [body, view] of this.views) {
      if (this.seen.has(body)) continue;
      this.scene.remove(view);
      this.views.delete(body);
    }
  }

  dispose(): void {
    for (const view of this.views.values()) this.scene.remove(view);
    this.views.clear();
  }
}
