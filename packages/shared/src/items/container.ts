import type { Prop } from "../sim/world.ts";
import type { ContainerSave, StackSave } from "../save/snapshot.ts";
import { OBJECT_SHEET } from "../worldgen/generationSheet.ts";
import { ITEM_NAMES, MAX_STACK, ItemType, itemTypeFromName, type Inventory, type ItemGrid, type ItemStack } from "./inventory.ts";
import { PICKUP_REACH } from "./pickupField.ts";

/**
 * Containers: props that hold items.
 *
 * Three exist, a Present and a Gift (Christmas) and a Candy Bucket
 * (Halloween). Each is a world prop (worldgen/props.ts) and also an item
 * (inventory.ts): picked up with E once it is empty, placed again with left
 * mouse. Placing one adds a prop to the world (`World.addProp`), so a placed
 * container and a generated one are the same thing from there on.
 *
 * What a container holds lives here, in {@link ContainerField}, keyed by its
 * prop id -- not on the prop, which is regenerated whenever its chunk streams
 * back in. A container nobody has opened has no storage at all; it is made the
 * first time it is looked at, from the prop's `loot` (empty today: the loot
 * tables are not written).
 */

export type ContainerKind = "present_small" | "present_big" | "bucket_candy";

/** The item a container becomes when it is picked up. */
export const CONTAINER_ITEMS: Readonly<Record<ContainerKind, ItemType>> = {
  present_small: ItemType.PresentSmall,
  present_big: ItemType.PresentBig,
  bucket_candy: ItemType.CandyBucket,
};

/**
 * What the player sees a container called, on the ground and in the inventory
 * (present_1.glb is the Present, present_2.glb the Gift).
 */
export const CONTAINER_NAMES: Readonly<Record<ContainerKind, string>> = {
  present_small: "Present",
  present_big: "Gift",
  bucket_candy: "Candy Bucket",
};

export const CONTAINER_KINDS =Object.keys(CONTAINER_ITEMS) as readonly ContainerKind[];

export function isContainerKind(kind: string): kind is ContainerKind {
  return kind in CONTAINER_ITEMS;
}

/** The container a held item places, if it is one. */
export function containerKindOfItem(type: ItemType): ContainerKind | undefined {
  return CONTAINER_KINDS.find((kind) => CONTAINER_ITEMS[kind] === type);
}

export interface ContainerGridShape {
  readonly columns: number;
  readonly rows: number;
}

const FALLBACK_GRID: ContainerGridShape = { columns: 4, rows: 2 };

/** The shape of a container's storage, from the generation sheet. */
export function containerGridShape(kind: ContainerKind): ContainerGridShape {
  return OBJECT_SHEET[kind].grid ?? FALLBACK_GRID;
}

/** The most slots any container has, for the screen to size its pool. */
export const MAX_CONTAINER_SLOTS = Math.max(
  ...CONTAINER_KINDS.map((kind) => {
    const shape = containerGridShape(kind);
    return shape.columns * shape.rows;
  }),
);

/** What a container holds. */
export class ContainerStorage implements ItemGrid {
  readonly size: number;
  /** Bumped on every change. */
  version = 0;
  /** Told when the storage goes from empty to not empty or back, for the prop's look. */
  onEmptyChanged: ((empty: boolean) => void) | undefined;

  private readonly slots: (ItemStack | undefined)[];

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    this.size = columns * rows;
    this.slots = new Array<ItemStack | undefined>(this.size).fill(undefined);
  }

  get isEmpty(): boolean {
    return this.slots.every((stack) => stack === undefined);
  }

  slot(index: number): ItemStack | undefined {
    return this.slots[index];
  }

  accepts(index: number, _type: ItemType): boolean {
    return index >= 0 && index < this.size;
  }

  setSlot(index: number, stack: ItemStack | undefined): void {
    if (index < 0 || index >= this.size) return;
    const wasEmpty = this.isEmpty;
    this.slots[index] = stack === undefined || stack.count <= 0 ? undefined : stack;
    this.version++;
    const empty = this.isEmpty;
    if (empty !== wasEmpty) this.onEmptyChanged?.(empty);
  }

  /** Tops up stacks of `type`, then fills empty slots. False, and nothing added, if it will not all fit. */
  tryAdd(type: ItemType, count = 1): boolean {
    let room = 0;
    for (const stack of this.slots) {
      if (stack === undefined) room += MAX_STACK;
      else if (stack.type === type) room += MAX_STACK - stack.count;
    }
    if (room < count) return false;
    let left = count;
    for (let i = 0; i < this.size && left > 0; i++) {
      const stack = this.slots[i];
      if (stack === undefined || stack.type !== type) continue;
      const moved = Math.min(left, MAX_STACK - stack.count);
      this.setSlot(i, { type, count: stack.count + moved });
      left -= moved;
    }
    for (let i = 0; i < this.size && left > 0; i++) {
      if (this.slots[i] !== undefined) continue;
      const moved = Math.min(left, MAX_STACK);
      this.setSlot(i, { type, count: moved });
      left -= moved;
    }
    return true;
  }
}

/**
 * Moves everything in `from` that fits into `to`, slot by slot. What does not
 * fit stays where it was. Returns how many items moved.
 */
export function takeAll(from: ItemGrid, to: Inventory): number {
  let moved = 0;
  for (let i = 0; i < from.size; i++) {
    const stack = from.slot(i);
    if (stack === undefined) continue;
    const count = Math.min(stack.count, to.roomFor(stack.type));
    if (count <= 0 || !to.tryAdd(stack.type, count)) continue;
    from.setSlot(i, count < stack.count ? { type: stack.type, count: stack.count - count } : undefined);
    moved += count;
  }
  return moved;
}

/** The contents of every container the player has looked at. */
export class ContainerField {
  private readonly storages = new Map<number, ContainerStorage>();

  /** A container's look changes with whether it is empty (an open gift, a bare bucket). */
  onEmptyChanged: ((propId: number, empty: boolean) => void) | undefined;

  /** The storage of a container prop, made (and filled from the prop's loot) on first use. */
  storageFor(prop: Pick<Prop, "id" | "kind" | "loot">): ContainerStorage {
    let storage = this.storages.get(prop.id);
    if (storage === undefined) {
      const shape = containerGridShape(prop.kind as ContainerKind);
      storage = new ContainerStorage(shape.columns, shape.rows);
      for (const name of prop.loot) {
        const type = itemTypeFromName(name);
        if (type !== undefined) storage.tryAdd(type);
      }
      const id = prop.id;
      storage.onEmptyChanged = (empty) => this.onEmptyChanged?.(id, empty);
      this.storages.set(id, storage);
    }
    return storage;
  }

  /** Whether a container prop is empty, without making storage for it unless its loot needs it. */
  isEmpty(prop: Pick<Prop, "id" | "kind" | "loot">): boolean {
    const storage = this.storages.get(prop.id);
    if (storage !== undefined) return storage.isEmpty;
    return prop.loot.every((name) => itemTypeFromName(name) === undefined);
  }

  /** Drops a container's storage (it was picked up; it was empty). */
  forget(propId: number): void {
    this.storages.delete(propId);
  }

  /** Changes whenever any container is opened, filled or emptied, for a saver to notice. */
  get revision(): number {
    let total = this.storages.size;
    for (const storage of this.storages.values()) total += storage.version;
    return total;
  }

  /**
   * Every container that has storage, empty ones included: an emptied container must
   * come back empty, not refilled from its loot.
   */
  exportAll(): ContainerSave[] {
    const out: ContainerSave[] = [];
    for (const [id, storage] of this.storages) {
      const slots: (StackSave | null)[] = [];
      for (let i = 0; i < storage.size; i++) {
        const stack = storage.slot(i);
        slots.push(stack === undefined ? null : { item: ITEM_NAMES[stack.type] ?? "", count: stack.count });
      }
      out.push({ id, columns: storage.columns, rows: storage.rows, slots });
    }
    return out;
  }

  /** Puts a saved container's contents back (before its prop is drawn, so it is drawn as it was). */
  restore(save: ContainerSave): void {
    const storage = new ContainerStorage(save.columns, save.rows);
    save.slots.forEach((stack, i) => {
      const type = stack === null ? undefined : itemTypeFromName(stack.item);
      if (stack !== null && type !== undefined) storage.setSlot(i, { type, count: stack.count });
    });
    storage.version = 0;
    const id = save.id;
    storage.onEmptyChanged = (empty) => this.onEmptyChanged?.(id, empty);
    this.storages.set(id, storage);
  }
}

/** Height of the player's middle above their feet, which reach is measured from. */
const BODY_CENTRE_METERS = 0.9;

/** Whether a prop is close enough to open: the same reach as picking an item up. */
export function inContainerReach(prop: Prop, x: number, y: number, z: number): boolean {
  const dx = prop.x - x;
  const dz = prop.z - z;
  // From the middle of the body, to the middle of the container.
  const dy = prop.y + prop.height / 2 - (y + BODY_CENTRE_METERS);
  return Math.hypot(dx, dy, dz) <= PICKUP_REACH + prop.radius;
}
