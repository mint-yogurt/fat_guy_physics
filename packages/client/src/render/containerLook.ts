import {
  Box3,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
  type Material,
  type Object3D,
} from "three/webgpu";

import type { ContainerKind } from "@fgp/shared/items/container";
import { BUCKET_FILLING_NODE } from "@fgp/shared/worldgen/props";

import type { PropTemplates } from "./propAssets.ts";

/**
 * How a container looks full or empty, and its mesh as an item.
 *
 *  - A present is one cube. Its top face is split off into its own material
 *    slot when the template is loaded ({@link splitTopFace}); an empty present
 *    shows that face black.
 *  - A candy bucket hides its `filling` node (the candy corn) when empty.
 *
 * A container you can pick up is always empty, so the item meshes (hand,
 * hotbar, inventory, dropped on the ground) are all drawn empty.
 */

let darkTop: Material | undefined;

/** Plain unlit black: the hole where the present's opening animation and interior texture will go. */
function darkTopMaterial(): Material {
  darkTop ??= new MeshBasicNodeMaterial({ color: 0x000000, side: DoubleSide });
  return darkTop;
}

/** The kinds whose emptiness is shown by blackening the top face. */
export function hasTopFace(kind: string): boolean {
  return kind === "present_small" || kind === "present_big";
}

/**
 * Regroups a mesh's triangles so those facing up the file's +Z come last, as
 * a second material group. The caller then gives the mesh two materials.
 * Returns false if the mesh has no index or normals to work from.
 */
export function splitTopFace(mesh: Mesh): boolean {
  const geometry = mesh.geometry;
  const index = geometry.index;
  const normal = geometry.getAttribute("normal");
  if (index === null) return false;

  const side: number[] = [];
  const top: number[] = [];
  for (let t = 0; t < index.count; t += 3) {
    const a = index.getX(t);
    const b = index.getX(t + 1);
    const c = index.getX(t + 2);
    const facesUp = normal.getZ(a) > 0.5 && normal.getZ(b) > 0.5 && normal.getZ(c) > 0.5;
    (facesUp ? top : side).push(a, b, c);
  }
  if (top.length === 0) return false;

  geometry.setIndex([...side, ...top]);
  geometry.clearGroups();
  geometry.addGroup(0, side.length, 0);
  geometry.addGroup(side.length, top.length, 1);
  return true;
}

/** Sets a container instance's look (a clone of its template) to full or empty. */
export function setContainerEmpty(root: Object3D, kind: ContainerKind, empty: boolean): void {
  if (hasTopFace(kind)) {
    root.traverse((child) => {
      if (!(child instanceof Mesh) || !Array.isArray(child.material) || child.material.length !== 2) return;
      // Index 0 is the wrapping paper; the top face shows it again when full.
      // TODO(opening animation): the lid opens and an inside texture goes on the
      // top face instead of plain black; both are being authored.
      const paper = child.material[0] as Material;
      child.material[1] = empty ? darkTopMaterial() : paper;
    });
    return;
  }
  const filling = root.getObjectByName(BUCKET_FILLING_NODE);
  if (filling !== undefined) filling.visible = !empty;
}

/** An empty container's mesh at its template's own scale (authored units), or undefined if not loaded. */
export function emptyContainerClone(templates: PropTemplates, kind: ContainerKind): Object3D | undefined {
  const template = templates.get(kind);
  if (template === undefined) return undefined;
  const clone = template.clone(true);
  setContainerEmpty(clone, kind, true);
  return clone;
}

/**
 * An empty container with its longest side `size` metres, centred on its
 * middle: what a hand, or the ground, wants.
 */
export function emptyContainerFitted(
  templates: PropTemplates,
  kind: ContainerKind,
  size: number,
): Object3D {
  const holder = new Group();
  const clone = emptyContainerClone(templates, kind);
  if (clone === undefined) return holder;
  clone.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(clone);
  const extent = bounds.getSize(new Vector3());
  const centre = bounds.getCenter(new Vector3());
  const scale = size / Math.max(extent.x, extent.y, extent.z, 1e-6);
  const inner = new Group();
  inner.scale.setScalar(scale);
  inner.position.copy(centre).multiplyScalar(-scale);
  inner.add(clone);
  holder.add(inner);
  return holder;
}
