import {
  Color,
  Group,
  Quaternion,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Object3D,
  type Scene,
  type Texture,
} from "three/webgpu";

import { containerKindOfItem } from "@fgp/shared/items/container";
import { ItemType } from "@fgp/shared/items/inventory";
import type { PickupField } from "@fgp/shared/items/pickupField";

import { emptyContainerFitted } from "./containerLook.ts";
import { STICK_LENGTH, type ItemAssets } from "./itemAssets.ts";
import type { PropTemplates } from "./propAssets.ts";

/**
 * Dropped items, drawn as their own meshes: a log is a little log and a
 * stick is the stick, hovering over the ground and slowly turning about the
 * vertical so they catch the eye. Leaves are still a camera-facing billboard
 * of their hotbar icon until they get a mesh of their own.
 *
 * A stuck stick (one thrown into something) is drawn where and how it went
 * in, and does not turn.
 */

/** Radians per second an item on the ground turns. */
export const SPIN_SPEED = 0.9;
const LEAF_SIZE = 0.2;
/** Lying sticks are drawn smaller than in the hand, so a pile reads as litter. */
const GROUND_STICK_SCALE = 0.6;
/** A dropped rock is smaller than one lying in the world, which is the real thing. */
const GROUND_ROCK_SCALE = 0.7;
/** A dropped container's longest side, metres: smaller than the placed one, like the rest. */
const GROUND_CONTAINER_SIZE = 0.4;

const FALLBACK_COLORS: Record<ItemType, number> = {
  [ItemType.Leaf]: 0x4e8c2b,
  [ItemType.Stick]: 0x8a6033,
  [ItemType.Log]: 0x5c3f22,
  [ItemType.Trampoline]: 0x2d5a8c,
  [ItemType.Skateboard]: 0xb03a2e,
  [ItemType.Snowball]: 0xf3f7fb,
  [ItemType.XmasLights]: 0xc83a3a,
  [ItemType.Rock]: 0x7d7f84,
  [ItemType.MountainLightning]: 0x62e03c,
  [ItemType.Eggnog]: 0xf2e6c4,
  [ItemType.Coal]: 0x1c1c20,
  [ItemType.Goo]: 0x62e03c,
  [ItemType.Metal]: 0x9aa0a8,
  [ItemType.Candy]: 0xd94a6a,
  [ItemType.PresentSmall]: 0xc83a3a,
  [ItemType.PresentBig]: 0x2f9a4a,
  [ItemType.CandyBucket]: 0xd9741a,
};

const Z_AXIS = new Vector3(0, 0, 1);
const direction = new Vector3();
const tilt = new Quaternion();

export class PickupRenderer {
  private readonly objects = new Map<number, Object3D>();
  private readonly spriteMaterials = new Map<ItemType, SpriteMaterial>();

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
    private readonly icons: Partial<Record<ItemType, Texture>> = {},
    private readonly props: PropTemplates = new Map(),
  ) {}

  private spriteFor(type: ItemType): Sprite {
    let material = this.spriteMaterials.get(type);
    if (material === undefined) {
      const map = this.icons[type];
      material =
        map === undefined
          ? new SpriteMaterial({ color: new Color(FALLBACK_COLORS[type]) })
          : // Cut out rather than blended, as the bushes are: an icon is
            // mostly transparent, and sorting a few hundred of them against
            // each other is not worth it for litter on the ground.
            new SpriteMaterial({ map, alphaTest: 0.5, transparent: false });
      this.spriteMaterials.set(type, material);
    }
    const sprite = new Sprite(material);
    sprite.scale.setScalar(LEAF_SIZE);
    return sprite;
  }

  private build(type: ItemType, stuck: boolean): Object3D {
    if (type === ItemType.Stick) {
      const stick = this.assets.stick.clone();
      if (stuck) return stick;
      // Lying down and centred on the pickup point, so it spins about its
      // middle rather than swinging round its butt.
      stick.scale.setScalar(GROUND_STICK_SCALE);
      stick.position.z = -0.5 * STICK_LENGTH * GROUND_STICK_SCALE;
      const pivot = new Group();
      pivot.add(stick);
      return pivot;
    }
    if (type === ItemType.Log) {
      const log = this.assets.log.clone();
      // On its side: the cylinder's axis is horizontal.
      log.rotation.z = Math.PI / 2;
      const pivot = new Group();
      pivot.add(log);
      return pivot;
    }
    if (type === ItemType.Skateboard) {
      const board = this.assets.skateboard.clone();
      // Origin at the wheels; the pickup point is its middle.
      board.position.y = -this.assets.skateboardHeight / 2;
      const pivot = new Group();
      pivot.add(board);
      return pivot;
    }
    if (type === ItemType.Snowball) {
      const pivot = new Group();
      pivot.add(this.assets.snowball.clone());
      return pivot;
    }
    if (type === ItemType.Rock) {
      const pivot = new Group();
      const rock = this.assets.rock.clone();
      rock.scale.multiplyScalar(GROUND_ROCK_SCALE);
      pivot.add(rock);
      return pivot;
    }
    if (type === ItemType.MountainLightning) {
      const pivot = new Group();
      pivot.add(this.assets.mountainLightning.clone());
      return pivot;
    }
    if (type === ItemType.Eggnog) {
      const pivot = new Group();
      pivot.add(this.assets.eggnog.clone());
      return pivot;
    }
    if (type === ItemType.Coal) {
      const pivot = new Group();
      pivot.add(this.assets.coal.clone());
      return pivot;
    }
    if (type === ItemType.Metal) {
      const pivot = new Group();
      pivot.add(this.assets.metal.clone());
      return pivot;
    }
    if (type === ItemType.Candy) {
      const pivot = new Group();
      pivot.add(this.assets.candy.clone());
      return pivot;
    }
    if (type === ItemType.Goo) {
      const pivot = new Group();
      pivot.add(this.assets.goo.clone());
      return pivot;
    }
    if (type === ItemType.XmasLights) {
      const pivot = new Group();
      pivot.add(this.assets.ropeCoil.clone());
      return pivot;
    }
    const container = containerKindOfItem(type);
    if (container !== undefined) {
      const pivot = new Group();
      pivot.add(emptyContainerFitted(this.props, container, GROUND_CONTAINER_SIZE));
      return pivot;
    }
    return this.spriteFor(type);
  }

  sync(field: PickupField, now: number): void {
    for (const id of field.removed) {
      const object = this.objects.get(id);
      if (object === undefined) continue;
      this.scene.remove(object);
      this.objects.delete(id);
    }

    for (const item of field.items) {
      let object = this.objects.get(item.id);
      if (object === undefined) {
        object = this.build(item.type, item.stuck !== undefined);
        if (item.stuck !== undefined) {
          direction.set(item.stuck.x, item.stuck.y, item.stuck.z);
          object.quaternion.copy(tilt.setFromUnitVectors(Z_AXIS, direction));
        }
        this.scene.add(object);
        this.objects.set(item.id, object);
      }
      object.position.set(item.x, item.y, item.z);
      if (item.stuck === undefined && item.type !== ItemType.Leaf) {
        object.rotation.y = (now - item.spawnTime) * SPIN_SPEED + item.id;
      }
    }
  }

  clear(): void {
    for (const object of this.objects.values()) this.scene.remove(object);
    this.objects.clear();
    for (const material of this.spriteMaterials.values()) material.dispose();
    this.spriteMaterials.clear();
  }
}
