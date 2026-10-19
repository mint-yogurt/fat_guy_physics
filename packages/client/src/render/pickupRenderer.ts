import { Sprite, SpriteMaterial, Color, type Scene, type Texture } from "three/webgpu";

import { ItemType } from "@fgp/shared/items/inventory";
import type { PickupField } from "@fgp/shared/items/pickupField";

/**
 * Dropped items, as camera-facing billboards.
 *
 * Each item draws its hotbar icon where one exists -- the leaf puff a
 * harvested canopy bursts into is a crowd of the same leaf the hotbar
 * shows -- and falls back to a flat colour where it does not.
 */

const SIZES: Record<ItemType, number> = {
  [ItemType.Leaf]: 0.2,
  [ItemType.Stick]: 0.3,
  [ItemType.Log]: 0.4,
};

const COLORS: Record<ItemType, number> = {
  [ItemType.Leaf]: 0x4e8c2b,
  [ItemType.Stick]: 0x8a6033,
  [ItemType.Log]: 0x5c3f22,
};

export class PickupRenderer {
  private readonly sprites = new Map<number, Sprite>();
  /** One material per item type, shared by every sprite of that type. */
  private readonly materials = new Map<ItemType, SpriteMaterial>();

  constructor(
    private readonly scene: Scene,
    private readonly icons: Partial<Record<ItemType, Texture>> = {},
  ) {}

  private materialFor(type: ItemType): SpriteMaterial {
    let material = this.materials.get(type);
    if (material === undefined) {
      const map = this.icons[type];
      material =
        map === undefined
          ? new SpriteMaterial({ color: new Color(COLORS[type]) })
          : // Cut out rather than blended, as the bushes are: an icon is
            // mostly transparent, and sorting a few hundred of them against
            // each other is not worth it for litter on the ground.
            new SpriteMaterial({ map, alphaTest: 0.5, transparent: false });
      this.materials.set(type, material);
    }
    return material;
  }

  sync(field: PickupField): void {
    for (const id of field.removed) {
      const sprite = this.sprites.get(id);
      if (sprite === undefined) continue;
      this.scene.remove(sprite);
      this.sprites.delete(id);
    }

    for (const item of field.items) {
      let sprite = this.sprites.get(item.id);
      if (sprite === undefined) {
        sprite = new Sprite(this.materialFor(item.type));
        const size = SIZES[item.type];
        sprite.scale.set(size, size, size);
        this.scene.add(sprite);
        this.sprites.set(item.id, sprite);
      }
      sprite.position.set(item.x, item.y, item.z);
    }
  }

  clear(): void {
    for (const sprite of this.sprites.values()) this.scene.remove(sprite);
    this.sprites.clear();
    for (const material of this.materials.values()) material.dispose();
    this.materials.clear();
  }
}
