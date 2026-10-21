import { Color, Group, Sprite, SpriteMaterial, type Object3D, type Texture } from "three/webgpu";

import { HoldStyle, holdStyleOf } from "@fgp/shared/items/avatarPose";
import type { ContainerKind } from "@fgp/shared/items/container";
import { ItemType } from "@fgp/shared/items/inventory";

import { emptyContainerFitted } from "./containerLook.ts";
import type { ItemAssets } from "./itemAssets.ts";
import type { PropTemplates } from "./propAssets.ts";

/**
 * Meshes for items in a hand, shared by the first-person arm and every
 * third-person character. Each is built in metres, in a frame set by its
 * hold style, with its origin at the point the hand closes on:
 *
 *  - Blade: the shaft runs along +Z from the grip, business end out.
 *  - Carry: the long axis runs along +X, centred.
 *  - Pinch: a small thing at the origin, facing the camera.
 *  - Ball: a sphere centred on the origin, in the fist.
 *
 * The views only know hold styles. Giving a new item a style in
 * @fgp/shared/items/avatarPose and a builder here is all it takes for both
 * views to show it held and swing it in the right way.
 */

/** A held log is drawn smaller than one on the ground, so it fits the hands. */
const HELD_LOG_SCALE = 0.65;
const HELD_LEAF_SIZE = 0.14;
/** A held snowball is bigger than the one on the ground reads, so it fills the fist. */
const HELD_SNOWBALL_SCALE = 1.2;
/** A rock in the fist: the world's rock is bigger than a fist, so it is drawn smaller than it lies. */
const HELD_ROCK_SCALE = 0.6;
/** A held can is drawn a little bigger than on the ground, so the fist closes round it. */
const HELD_CAN_SCALE = 1.15;
/** A held carton of eggnog: the whole 24cm is more than a fist, so it is drawn smaller. */
const HELD_EGGNOG_SCALE = 0.85;
/** A held lump of coal, block of metal or heap of candy. */
const HELD_COAL_SCALE = 1.1;
/** A held trampoline is a toy-sized one, so it fits the arms. */
const HELD_TRAMPOLINE_SCALE = 0.2;
/** A held coil of lights is drawn a little bigger than on the ground, so it fills the fist. */
const HELD_COIL_SCALE = 1.1;

/** Longest side of a held container, metres: a gift fills the arms, a pail hangs from one hand's reach. */
const HELD_CONTAINER_SIZE: Readonly<Record<ContainerKind, number>> = {
  present_small: 0.4,
  present_big: 0.55,
  bucket_candy: 0.8,
};

export interface HeldItemSources {
  readonly assets: ItemAssets;
  /** The prop meshes, for items that are a container (always held empty). */
  readonly props: PropTemplates;
  /** Billboard icons, for items that have no mesh yet. */
  readonly icons: Partial<Record<ItemType, Texture>>;
}

type Builder = (sources: HeldItemSources) => Object3D;

function heldContainer(sources: HeldItemSources, kind: ContainerKind): Object3D {
  const carry = new Group();
  carry.add(emptyContainerFitted(sources.props, kind, HELD_CONTAINER_SIZE[kind]));
  return carry;
}

function iconSprite(sources: HeldItemSources, type: ItemType, size: number, fallback: number): Object3D {
  const map = sources.icons[type];
  const material =
    map === undefined
      ? new SpriteMaterial({ color: new Color(fallback) })
      : new SpriteMaterial({ map, alphaTest: 0.5, transparent: false });
  const sprite = new Sprite(material);
  sprite.scale.setScalar(size);
  return sprite;
}

const BUILDERS: Record<ItemType, Builder> = {
  [ItemType.Stick]: ({ assets }) => {
    const grip = new Group();
    const stick = assets.stick.clone();
    stick.position.z = -assets.stickGrip;
    grip.add(stick);
    return grip;
  },
  [ItemType.Log]: ({ assets }) => {
    const carry = new Group();
    const log = assets.log.clone();
    log.scale.multiplyScalar(HELD_LOG_SCALE);
    // Authored along +Y; Carry wants +X.
    log.rotation.z = -Math.PI / 2;
    carry.add(log);
    return carry;
  },
  [ItemType.Trampoline]: ({ assets }) => {
    const carry = new Group();
    const mat = assets.trampoline.clone();
    mat.scale.multiplyScalar(HELD_TRAMPOLINE_SCALE);
    carry.add(mat);
    return carry;
  },
  // Under the feet, not in a hand: see skateboardView.ts.
  [ItemType.Skateboard]: () => new Group(),
  [ItemType.Snowball]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.snowball.clone();
    mesh.scale.multiplyScalar(HELD_SNOWBALL_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.Rock]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.rock.clone();
    mesh.scale.multiplyScalar(HELD_ROCK_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.MountainLightning]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.mountainLightning.clone();
    mesh.scale.multiplyScalar(HELD_CAN_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.Eggnog]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.eggnog.clone();
    mesh.scale.multiplyScalar(HELD_EGGNOG_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.Coal]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.coal.clone();
    mesh.scale.multiplyScalar(HELD_COAL_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.Metal]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.metal.clone();
    mesh.scale.multiplyScalar(HELD_COAL_SCALE);
    ball.add(mesh);
    return ball;
  },
  [ItemType.Candy]: ({ assets }) => {
    const ball = new Group();
    const mesh = assets.candy.clone();
    mesh.scale.multiplyScalar(HELD_COAL_SCALE);
    ball.add(mesh);
    return ball;
  },
  // In the hand it is a ball of it; as an item (slot, ground) it is the puddle.
  [ItemType.Goo]: ({ assets }) => {
    const ball = new Group();
    ball.add(assets.gooBall.clone());
    return ball;
  },
  [ItemType.XmasLights]: ({ assets }) => {
    const coil = new Group();
    const mesh = assets.ropeCoil.clone();
    mesh.scale.multiplyScalar(HELD_COIL_SCALE);
    coil.add(mesh);
    return coil;
  },
  [ItemType.PresentSmall]: (sources) => heldContainer(sources, "present_small"),
  [ItemType.PresentBig]: (sources) => heldContainer(sources, "present_big"),
  [ItemType.CandyBucket]: (sources) => heldContainer(sources, "bucket_candy"),
  [ItemType.Leaf]: (sources) => iconSprite(sources, ItemType.Leaf, HELD_LEAF_SIZE, 0x4e8c2b),
};

/**
 * One view's held items: builds each item's mesh the first time it is held,
 * under `parent`, and shows whichever is held now.
 */
export class HeldItemSlot {
  private readonly built = new Map<ItemType, Object3D>();
  private shown: ItemType | undefined;

  constructor(
    private readonly parent: Object3D,
    private readonly sources: HeldItemSources,
  ) {}

  /** Shows `held` (or nothing); returns its hold style. */
  show(held: ItemType | undefined, visible = true): HoldStyle {
    if (held !== this.shown) {
      if (this.shown !== undefined) {
        const old = this.built.get(this.shown);
        if (old !== undefined) old.visible = false;
      }
      this.shown = held;
    }
    if (held !== undefined) {
      let object = this.built.get(held);
      if (object === undefined) {
        object = BUILDERS[held](this.sources);
        object.traverse((child) => {
          child.frustumCulled = false;
        });
        this.parent.add(object);
        this.built.set(held, object);
      }
      object.visible = visible;
    }
    return holdStyleOf(held);
  }
}
