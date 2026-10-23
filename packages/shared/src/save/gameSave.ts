import type { ContainerField } from "../items/container.ts";
import type { RecipeBook } from "../items/crafting.ts";
import { ITEM_NAMES, itemTypeFromName, type Inventory } from "../items/inventory.ts";
import type { PickupField } from "../items/pickupField.ts";
import type { BuildField } from "../items/building.ts";
import type { TrampolineField } from "../items/trampoline.ts";
import { KILL_PLANE_Y, type Player } from "../sim/player.ts";
import { WORLD_CEILING_METERS, type World } from "../sim/world.ts";
import {
  MAX_SAVED_PICKUPS,
  SAVE_VERSION,
  type PickupSave,
  type PlayerSave,
  type StackSave,
  type WorldSave,
} from "./snapshot.ts";

/**
 * Turning the live game into a save and back. No DOM and no storage here: this is the
 * seam between the sim and `SaveStore`, and the authoritative server will call the
 * same functions.
 *
 * Everything that is not listed here is deliberately not saved, because it is either
 * regenerated from the seed (terrain, trees, props, snowmen) or short-lived: things in
 * flight, rolled snowballs and rocks, felled logs, strings of lights. See README "Saving".
 */

/** Highest feet height a restored player may be put at: inside the world's ceiling. */
const MAX_RESTORED_Y = WORLD_CEILING_METERS - 0.5;

function stackSave(inventory: Pick<Inventory, "slot">, index: number): StackSave | null {
  const stack = inventory.slot(index);
  if (stack === undefined) return null;
  const item = ITEM_NAMES[stack.type];
  return item === undefined ? null : { item, count: stack.count };
}

export function capturePlayer(player: Player, inventory: Inventory, recipes: RecipeBook): PlayerSave {
  const slots: (StackSave | null)[] = [];
  for (let i = 0; i < inventory.size; i++) slots.push(i === 0 ? null : stackSave(inventory, i));
  return {
    version: SAVE_VERSION,
    savedAt: Date.now(),
    position: { x: player.x, y: player.y, z: player.z },
    yaw: player.yaw,
    pitch: player.pitch,
    selected: inventory.selectedSlot,
    slots,
    seen: recipes.types().flatMap((type) => ITEM_NAMES[type] ?? []),
  };
}

/** Puts a (sanitized) save into a fresh player, inventory and recipe book. */
export function applyPlayer(save: PlayerSave, player: Player, inventory: Inventory, recipes: RecipeBook): void {
  if (save.position !== null && save.position.y > KILL_PLANE_Y) {
    player.x = save.position.x;
    player.y = Math.min(save.position.y, MAX_RESTORED_Y);
    player.z = save.position.z;
  }
  player.setLook(save.yaw, save.pitch);

  save.slots.forEach((stack, i) => {
    if (stack === null || i === 0) return;
    const type = itemTypeFromName(stack.item);
    if (type !== undefined) inventory.setSlot(i, { type, count: stack.count });
  });
  inventory.selectSlot(save.selected);
  for (const name of save.seen) {
    const type = itemTypeFromName(name);
    if (type !== undefined) recipes.see(type);
  }
}

/** The pieces of the shared world a save covers. */
export interface WorldParts {
  readonly world: World;
  readonly containers: ContainerField;
  readonly trampolines: TrampolineField;
  readonly pieces: BuildField;
  readonly pickups: PickupField;
}

/** Changes when anything in {@link WorldParts} that a save covers changes. Cheap enough to poll. */
export function worldRevision(parts: WorldParts): string {
  return `${parts.world.editRevision}/${parts.containers.revision}/${parts.trampolines.items.length}/${parts.pieces.version}/${parts.pickups.items.length}`;
}

export function captureWorld(parts: WorldParts): WorldSave {
  const pickups: PickupSave[] = [];
  for (const item of parts.pickups.items) {
    if (pickups.length >= MAX_SAVED_PICKUPS) break;
    const name = ITEM_NAMES[item.type];
    if (name === undefined) continue;
    pickups.push(
      item.stuck === undefined
        ? { item: name, x: item.x, y: item.y, z: item.z }
        : { item: name, x: item.x, y: item.y, z: item.z, stuck: [item.stuck.x, item.stuck.y, item.stuck.z] },
    );
  }
  return {
    ...parts.world.exportEdits(),
    version: SAVE_VERSION,
    savedAt: Date.now(),
    containers: parts.containers.exportAll(),
    trampolines: parts.trampolines.items.map((mat) => ({ x: mat.x, baseY: mat.baseY, z: mat.z })),
    pieces: parts.pieces.exportAll(),
    pickups,
  };
}

/**
 * Puts a (sanitized) world save into a world that has not started streaming yet.
 *
 * `groundAt` and `now` are what a dropped item needs to settle onto the ground again
 * (the client's clock and ground sampler).
 */
export function applyWorld(
  save: WorldSave,
  parts: WorldParts,
  groundAt: (x: number, z: number) => number,
  now: number,
): void {
  // A save from another seed describes another world; none of it applies.
  if (save.seed !== parts.world.seed) return;

  parts.world.importEdits(save);
  for (const container of save.containers) parts.containers.restore(container);
  for (const mat of save.trampolines) parts.trampolines.place(mat.x, mat.baseY, mat.z);
  parts.pieces.restore(save.pieces);
  for (const pickup of save.pickups) {
    const type = itemTypeFromName(pickup.item);
    if (type === undefined) continue;
    if (pickup.stuck !== undefined) {
      parts.pickups.spawnStuck(type, pickup.x, pickup.y, pickup.z, pickup.stuck[0], pickup.stuck[1], pickup.stuck[2], now);
    } else {
      parts.pickups.spawn(type, pickup.x, pickup.y, pickup.z, groundAt(pickup.x, pickup.z), now);
    }
  }
}
