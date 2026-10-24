import {
  Box3,
  Color,
  DirectionalLight,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  Sprite,
  SpriteMaterial,
  Vector3,
  type Object3D,
  type WebGPURenderer,
} from "three/webgpu";

import { containerKindOfItem } from "@fgp/shared/items/container";
import { ItemType } from "@fgp/shared/items/inventory";

import { emptyContainerClone } from "./containerLook.ts";
import type { HeldItemSources } from "./heldItems.ts";
import { SPIN_SPEED } from "./pickupRenderer.ts";

/**
 * The hotbar's items, drawn as their meshes over the finished frame: floating
 * and slowly turning about the vertical like the ones on the ground.
 *
 * One pass on the main renderer rather than a canvas per slot. The camera is
 * orthographic and in CSS pixels, so a slot's DOM rectangle is also where its
 * item goes. Because the canvas sits underneath the DOM, the slot backdrops
 * are drawn here too (the translucent CSS ones would dim the items).
 */

/** The longest side of an item, in CSS pixels. */
const ITEM_PX = 40;
/** A hotbar item's longest side as a share of its slot (40 in a 56 slot, before the UI scale). */
const HOTBAR_ITEM_FILL = 40 / 56;
/** Tilted toward the camera, so the top of a spinning item can be seen. */
const TILT = 0.5;
const BACKDROP = new Color(0x0a0e14);
const BACKDROP_OPACITY = 0.42;
const BACKDROP_OPACITY_SELECTED = 0.66;
const BACKDROP_DEPTH = -100;

export interface HotbarSlotView {
  /** The slot's rectangle in CSS pixels, from the top-left of the window. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly item: ItemType | undefined;
  readonly selected: boolean;
  /**
   * For the inventory screen, which has panels as well as slots: the
   * backdrop's opacity (0 for none, as under the item on the cursor), how far
   * back it sits (more negative is further, so a panel is behind its slots),
   * and the item's longest side in pixels. Each defaults to the hotbar's.
   */
  readonly backdropOpacity?: number;
  readonly backdropDepth?: number;
  readonly itemPx?: number;
  /** Drawn this much nearer the camera, so the item on the cursor floats over the slots' items. */
  readonly lift?: number;
}

interface SlotObjects {
  readonly root: Group;
  readonly backdrop: Mesh;
  readonly backdropMaterial: MeshBasicMaterial;
  readonly spin: Group;
  shown: ItemType | undefined;
  holder: Object3D | undefined;
}

export class HotbarItems {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(0, 1, 0, -1, 0.1, 1000);
  private readonly slots: SlotObjects[] = [];
  private readonly backdropGeometry = new PlaneGeometry(1, 1);
  private width = 0;
  private height = 0;

  constructor(
    slotCount: number,
    private readonly sources: HeldItemSources,
  ) {
    this.camera.position.z = 500;
    this.scene.add(new HemisphereLight(0xcfe4f5, 0x4a3a2a, 2.4));
    const sun = new DirectionalLight(0xfff4e0, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);

    for (let i = 0; i < slotCount; i++) {
      const root = new Group();
      const backdropMaterial = new MeshBasicMaterial({
        color: BACKDROP,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      const backdrop = new Mesh(this.backdropGeometry, backdropMaterial);
      backdrop.position.z = BACKDROP_DEPTH;
      const tilt = new Group();
      tilt.rotation.x = TILT;
      const spin = new Group();
      tilt.add(spin);
      root.add(backdrop, tilt);
      this.scene.add(root);
      this.slots.push({ root, backdrop, backdropMaterial, spin, shown: undefined, holder: undefined });
    }
  }

  /** How an item sits on the ground, as PickupRenderer builds it. */
  private build(type: ItemType): Object3D {
    const { assets } = this.sources;
    const content = new Group();
    const containerKind = containerKindOfItem(type);
    if (type === ItemType.Stick) {
      content.add(assets.stick.clone());
    } else if (type === ItemType.Log) {
      const log = assets.log.clone();
      log.rotation.z = Math.PI / 2;
      content.add(log);
    } else if (type === ItemType.Trampoline) {
      content.add(assets.trampoline.clone());
    } else if (type === ItemType.Skateboard) {
      content.add(assets.skateboard.clone());
    } else if (type === ItemType.Snowball) {
      content.add(assets.snowball.clone());
    } else if (type === ItemType.Rock) {
      content.add(assets.rock.clone());
    } else if (type === ItemType.MountainLightning) {
      content.add(assets.mountainLightning.clone());
    } else if (type === ItemType.Eggnog) {
      content.add(assets.eggnog.clone());
    } else if (type === ItemType.Coal) {
      content.add(assets.coal.clone());
    } else if (type === ItemType.Metal) {
      content.add(assets.metal.clone());
    } else if (type === ItemType.Candy) {
      content.add(assets.candy.clone());
    } else if (type === ItemType.Toobifer) {
      content.add(assets.toobifer.clone());
    } else if (type === ItemType.Plywood) {
      content.add(assets.plywood.clone());
    } else if (type === ItemType.Wheel) {
      content.add(assets.wheel.clone());
    } else if (type === ItemType.Ladder) {
      content.add(assets.ladder.clone());
    } else if (type === ItemType.Spring) {
      content.add(assets.spring.clone());
    } else if (type === ItemType.SpringShoes) {
      content.add(assets.springShoeItem.clone());
    } else if (type === ItemType.FishingRod) {
      content.add(assets.fishingRod.clone());
    } else if (type === ItemType.Leaf) {
      content.add(assets.leaves.clone());
    } else if (type === ItemType.ToiletPaper) {
      content.add(assets.toiletPaper.clone());
    } else if (type === ItemType.Parachute) {
      content.add(assets.parachuteItem.clone());
    } else if (type === ItemType.Goo) {
      content.add(assets.goo.clone());
    } else if (type === ItemType.XmasLights) {
      content.add(assets.ropeCoil.clone());
    } else if (containerKind !== undefined) {
      const container = emptyContainerClone(this.sources.props, containerKind);
      if (container !== undefined) content.add(container);
    } else {
      const map = this.sources.icons[type];
      const sprite = new Sprite(
        map === undefined
          ? new SpriteMaterial({ color: new Color(0x4e8c2b) })
          : new SpriteMaterial({ map, alphaTest: 0.5, transparent: false }),
      );
      sprite.scale.setScalar(ITEM_PX);
      content.add(sprite);
      return content;
    }

    // Scaled to fill the slot and centred on its middle, whatever the
    // mesh's own size and origin are.
    content.updateMatrixWorld(true);
    const bounds = new Box3().setFromObject(content);
    const size = bounds.getSize(new Vector3());
    const centre = bounds.getCenter(new Vector3());
    const scale = ITEM_PX / Math.max(size.x, size.y, size.z, 1e-6);
    const holder = new Group();
    holder.scale.setScalar(scale);
    holder.position.copy(centre).multiplyScalar(-scale);
    holder.add(content);
    return holder;
  }

  render(renderer: WebGPURenderer, views: readonly HotbarSlotView[], now: number): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      // Y down, to match the DOM: a point at (x, y) on screen is (x, -y) here.
      this.camera.left = 0;
      this.camera.right = width;
      this.camera.top = 0;
      this.camera.bottom = -height;
      this.camera.updateProjectionMatrix();
    }

    let any = false;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const view = views[i];
      if (slot === undefined) continue;
      if (view === undefined || view.width === 0) {
        slot.root.visible = false;
        continue;
      }
      any = true;
      slot.root.visible = true;
      slot.root.position.set(view.x + view.width / 2, -(view.y + view.height / 2), view.lift ?? 0);
      slot.backdrop.scale.set(view.width, view.height, 1);
      slot.backdropMaterial.opacity =
        view.backdropOpacity ?? (view.selected ? BACKDROP_OPACITY_SELECTED : BACKDROP_OPACITY);
      slot.backdrop.position.z = view.backdropDepth ?? BACKDROP_DEPTH;
      // Sized from the slot, so the item follows the UI scale (ui.css `--ui-scale`).
      slot.spin.scale.setScalar((view.itemPx ?? view.width * HOTBAR_ITEM_FILL) / ITEM_PX);

      if (view.item !== slot.shown) {
        if (slot.holder !== undefined) slot.spin.remove(slot.holder);
        slot.holder = view.item === undefined ? undefined : this.build(view.item);
        if (slot.holder !== undefined) {
          slot.holder.traverse((child) => {
            child.frustumCulled = false;
          });
          slot.spin.add(slot.holder);
        }
        slot.shown = view.item;
      }
      slot.spin.rotation.y = now * SPIN_SPEED + i;
    }
    if (!any) return;

    const savedAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = savedAuto;
  }

  dispose(): void {
    this.backdropGeometry.dispose();
    for (const slot of this.slots) slot.backdropMaterial.dispose();
  }
}
