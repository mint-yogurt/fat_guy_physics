import { Box3, Group, Vector3, type Object3D } from "three/webgpu";

import { PIECE_SPECS } from "@fgp/shared/items/building";
import { ItemType } from "@fgp/shared/items/inventory";

import type { ItemAssets } from "./itemAssets.ts";

/**
 * A building piece as it is in the world, not as a slot or the ground shows it:
 * the item's own mesh stretched to fill the piece's collision shape
 * (shared/items/building.ts `size`), centred on the piece's middle, its axes
 * the piece's. The items are drawn far smaller than they are so they read in a
 * hand and a slot; a placed piece is the real size.
 *
 * Stretching to the shape (rather than scaling evenly) is what keeps the look
 * and the collision the same thing: a sheet of plywood is a 10cm slab because
 * the player cannot stand on anything thinner, and the mesh is that slab too.
 *
 * To make another item a piece: a row in PIECE_SPECS, and a row here saying
 * which mesh it is and, if the model was authored on a different axis from the
 * piece's (the wheel's axle is X, a piece's cylinder runs along Y), how to turn
 * it.
 */

interface Source {
  readonly mesh: (assets: ItemAssets) => Object3D;
  /** Turn about Z, radians, to bring the model's axis onto the piece's. */
  readonly turnZ?: number;
}

const SOURCES: Partial<Record<ItemType, Source>> = {
  [ItemType.Ladder]: { mesh: (assets) => assets.ladder },
  [ItemType.Log]: { mesh: (assets) => assets.log },
  [ItemType.Toobifer]: { mesh: (assets) => assets.toobifer },
  [ItemType.Plywood]: { mesh: (assets) => assets.plywood },
  // The wheel is authored with its axle along X; a cylinder piece runs along Y.
  [ItemType.Wheel]: { mesh: (assets) => assets.wheel, turnZ: Math.PI / 2 },
};

export class PieceMeshes {
  private readonly templates = new Map<ItemType, Object3D>();

  constructor(private readonly assets: ItemAssets) {}

  /** A fresh copy of the piece's mesh, to be positioned and turned at its pose. Undefined for an item that is not a piece. */
  make(item: ItemType): Object3D | undefined {
    let template = this.templates.get(item);
    if (template === undefined) {
      template = this.build(item);
      if (template === undefined) return undefined;
      this.templates.set(item, template);
    }
    return template.clone();
  }

  private build(item: ItemType): Object3D | undefined {
    const source = SOURCES[item];
    const spec = PIECE_SPECS[item];
    if (source === undefined || spec === undefined) return undefined;

    const holder = new Group();
    holder.add(source.mesh(this.assets).clone());
    if (source.turnZ !== undefined) holder.rotation.z = source.turnZ;
    holder.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(holder);
    const size = bounds.getSize(new Vector3());
    const centre = bounds.getCenter(new Vector3());

    const fitted = new Group();
    fitted.scale.set(
      size.x > 1e-6 ? spec.size[0] / size.x : 1,
      size.y > 1e-6 ? spec.size[1] / size.y : 1,
      size.z > 1e-6 ? spec.size[2] / size.z : 1,
    );
    // The model's middle onto the origin, before the stretch.
    holder.position.sub(centre);
    fitted.add(holder);
    const root = new Group();
    root.add(fitted);
    return root;
  }
}
