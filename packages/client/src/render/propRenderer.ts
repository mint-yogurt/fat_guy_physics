import { Group, type Object3D, type Scene } from "three/webgpu";

import type { Prop } from "@fgp/shared/sim/world";
import { GRAVE_TOPSOIL_NODE } from "@fgp/shared/worldgen/props";

import type { PropTemplates } from "./propAssets.ts";

/**
 * Placed props: snowmen, presents, tombstones, graves.
 *
 * One clone of the kind's template per prop. Clones share the template's
 * geometry and materials, so a graveyard costs scene-graph nodes and draw
 * calls but no extra vertex memory; if the draw count ever shows up in a
 * profile these are the thing to instance.
 *
 * Nothing here is ever edited after placement -- props are not chopped or
 * dug -- so there is no per-instance state to keep beyond the node itself.
 */
export class PropRenderer {
  private readonly instances = new Map<number, Object3D>();

  constructor(
    private readonly scene: Scene,
    private readonly templates: PropTemplates,
  ) {}

  get count(): number {
    return this.instances.size;
  }

  onPropPlaced(prop: Prop): void {
    if (this.instances.has(prop.id)) return;
    const template = this.templates.get(prop.kind);
    if (template === undefined) return;

    const group = new Group();
    group.add(template.clone(true));
    group.position.set(prop.x, prop.y, prop.z);
    // Yaw outermost, then the lean in the prop's own frame: a crooked grave
    // leans along its own length or width, whichever way it is facing.
    group.rotation.set(prop.tiltX, prop.yaw, prop.tiltZ, "YXZ");
    group.scale.setScalar(prop.scale);

    // Open graves are the same mesh without its topsoil.
    if (prop.kind === "grave" && !prop.topsoil) {
      const soil = group.getObjectByName(GRAVE_TOPSOIL_NODE);
      if (soil !== undefined) soil.visible = false;
    }

    group.updateMatrix();
    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.instances.set(prop.id, group);
  }

  onPropUnloaded(propId: number): void {
    const group = this.instances.get(propId);
    if (group === undefined) return;
    this.instances.delete(propId);
    this.scene.remove(group);
  }

  clear(): void {
    for (const group of this.instances.values()) this.scene.remove(group);
    this.instances.clear();
  }
}
