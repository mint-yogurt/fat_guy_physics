import { Group, Matrix4, type Object3D, type Scene } from "three/webgpu";

import { isContainerKind, type ContainerField } from "@fgp/shared/items/container";
import type { Prop } from "@fgp/shared/sim/world";
import { GRAVE_TOPSOIL_NODE, PROP_METRICS, PROP_SECTIONS, type PropSection } from "@fgp/shared/worldgen/props";

import { setContainerEmpty } from "./containerLook.ts";
import type { PropTemplates } from "./propAssets.ts";

/**
 * Placed props: snowmen, presents, tombstones, graves.
 *
 * One clone of the kind's template per prop. Clones share the template's
 * geometry and materials, so a graveyard costs scene-graph nodes and draw
 * calls but no extra vertex memory; if the draw count ever shows up in a
 * profile these are the thing to instance.
 *
 * Props are not chopped or dug, so what changes after placement is little: a
 * container's look, full or empty (`setEmpty`), a snowbank's size as it is
 * used up, a snowman's parts as they come off, and a house exploding (`onPropChanged`).
 */
export class PropRenderer {
  private readonly instances = new Map<number, Object3D>();
  private readonly kinds = new Map<number, string>();
  /** The parts of each prop that were already off when it was last drawn. */
  private readonly shownBroken = new Map<number, number>();

  /**
   * A part of a prop came off. `piece` is a copy of it, in the world and
   * centred on its own middle (so it can be spun about it), not yet in the
   * scene: the callback launches it, or drops it.
   */
  onSectionBroken: ((prop: Prop, index: number, piece: Object3D) => void) | undefined = undefined;

  /**
   * A breakable prop (a house) has been hit to pieces and is about to be
   * removed. `model` is its model, still in the scene and placed in the world:
   * the callback tears it apart.
   */
  onShattered: ((prop: Prop, model: Object3D) => void) | undefined = undefined;

  constructor(
    private readonly scene: Scene,
    private readonly templates: PropTemplates,
    private readonly containers: ContainerField,
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

    // Open graves are the same mesh without its topsoil.
    if (prop.kind === "grave" && !prop.topsoil) {
      const soil = group.getObjectByName(GRAVE_TOPSOIL_NODE);
      if (soil !== undefined) soil.visible = false;
    }

    if (isContainerKind(prop.kind)) setContainerEmpty(group, prop.kind, this.containers.isEmpty(prop));

    this.fit(group, prop);
    group.matrixAutoUpdate = false;
    this.scene.add(group);
    this.instances.set(prop.id, group);
    this.kinds.set(prop.id, prop.kind);
    this.shownBroken.set(prop.id, prop.broken);
  }

  /**
   * The prop's size or parts changed (a snowbank shrank, a snowman lost its
   * head). Parts that have just come off are handed to `onSectionBroken`
   * first, while they are still on the model.
   */
  onPropChanged(prop: Prop): void {
    const group = this.instances.get(prop.id);
    if (group === undefined) return;
    if (PROP_METRICS[prop.kind].breakable !== undefined) {
      if (prop.broken !== 0) {
        group.updateWorldMatrix(true, true);
        this.onShattered?.(prop, group);
      }
      return;
    }
    const sections = PROP_SECTIONS[prop.kind];
    const before = this.shownBroken.get(prop.id) ?? 0;
    if (sections !== undefined && this.onSectionBroken !== undefined) {
      group.updateWorldMatrix(true, true);
      sections.forEach((section, index) => {
        const bit = 1 << index;
        if ((prop.broken & bit) === 0 || (before & bit) !== 0) return;
        const piece = this.copyOf(group, prop, section);
        if (piece !== undefined) this.onSectionBroken?.(prop, index, piece);
      });
    }
    this.shownBroken.set(prop.id, prop.broken);
    this.fit(group, prop);
  }

  /** A container was filled or emptied: show it. */
  setEmpty(propId: number, empty: boolean): void {
    const group = this.instances.get(propId);
    const kind = this.kinds.get(propId);
    if (group === undefined || kind === undefined || !isContainerKind(kind)) return;
    setContainerEmpty(group, kind, empty);
  }

  onPropUnloaded(propId: number): void {
    const group = this.instances.get(propId);
    if (group === undefined) return;
    this.instances.delete(propId);
    this.kinds.delete(propId);
    this.shownBroken.delete(propId);
    this.scene.remove(group);
  }

  clear(): void {
    for (const group of this.instances.values()) this.scene.remove(group);
    this.instances.clear();
    this.kinds.clear();
    this.shownBroken.clear();
  }

  /** Sizes the model to the prop and hides the parts that are off. */
  private fit(group: Object3D, prop: Prop): void {
    group.scale.setScalar(prop.scale);
    const sections = PROP_SECTIONS[prop.kind];
    if (sections !== undefined) {
      sections.forEach((section, index) => {
        const off = (prop.broken & (1 << index)) !== 0;
        for (const name of section.nodes) {
          const node = group.getObjectByName(name);
          if (node !== undefined) node.visible = !off;
        }
      });
    }
    group.updateMatrix();
  }

  /** The nodes of one part, copied out in the world frame and centred on the part's middle. */
  private copyOf(group: Object3D, prop: Prop, section: PropSection): Object3D | undefined {
    const piece = new Group();
    const centreY = prop.y + section.centre * prop.scale;
    piece.position.set(prop.x, centreY, prop.z);
    const toLocal = new Matrix4().makeTranslation(-prop.x, -centreY, -prop.z);
    for (const name of section.nodes) {
      const node = group.getObjectByName(name);
      if (node === undefined) continue;
      const copy = node.clone(true);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(node.matrixWorld).premultiply(toLocal);
      piece.add(copy);
    }
    return piece.children.length > 0 ? piece : undefined;
  }
}
