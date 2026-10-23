import { pieceSpecOf, type PieceSave } from "../items/building.ts";
import { HOTBAR_SLOTS, ITEM_NAMES, MAX_STACK, TOTAL_SLOTS, itemTypeFromName } from "../items/inventory.ts";
import { PROP_METRICS } from "../worldgen/props.ts";

/**
 * What a save is: plain JSON-safe data, and the rules for trusting it.
 *
 * Two saves, two scopes (see README "Saving"):
 *
 *  - {@link PlayerSave}: one player's own state (where they stand, what they carry).
 *  - {@link WorldSave}: everything players have changed in the shared world. The world
 *    itself is generated from its seed, so only the *difference* is stored.
 *
 * Both are versioned and both go through a `sanitize*` function on the way in. The
 * browser reads its own storage through the same functions the server will use on what
 * a client sends it, so a hand-edited or half-written save can lose data but cannot
 * crash the game or put a number in the sim that the sim never expected.
 *
 * Items are saved by NAME (`ITEM_NAMES`), never by numeric id: reordering the enum must
 * not turn everyone's sticks into skateboards. A name that no longer exists is dropped.
 */

export const SAVE_VERSION = 1;

/** A stack as saved. */
export interface StackSave {
  readonly item: string;
  readonly count: number;
}

export interface PlayerSave {
  readonly version: number;
  /** Date.now() when written, for humans and for the server to pick the newer of two. */
  readonly savedAt: number;
  /** Feet position, metres; null if it was not usable (the player starts at the spawn). */
  readonly position: { readonly x: number; readonly y: number; readonly z: number } | null;
  readonly yaw: number;
  readonly pitch: number;
  /** Hotbar slot in hand. */
  readonly selected: number;
  /** `TOTAL_SLOTS` long; index 0 (Unarmed) is always null. */
  readonly slots: readonly (StackSave | null)[];
  /**
   * Item names the player has ever held, which is what decides the crafting recipes
   * they know. Missing from older saves; the inventory fills it back in.
   */
  readonly seen: readonly string[];
}

export interface PlacedPropSave {
  readonly id: number;
  readonly kind: string;
  readonly biome: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  readonly fullScale: number;
  readonly loot: readonly string[];
  readonly broken: number;
}

/** The part of the world's edits that `World` itself owns. */
export interface WorldEdits {
  readonly seed: number;
  /** Tree id -> height it was cut at. */
  readonly severedTrees: readonly (readonly [number, number])[];
  /** Tree id -> bitmask of foliage clusters knocked off. */
  readonly strippedFoliage: readonly (readonly [number, number])[];
  readonly strippedLights: readonly number[];
  /** Generated props that were picked up or destroyed. */
  readonly removedProps: readonly number[];
  readonly placedProps: readonly PlacedPropSave[];
  readonly nextPlacedPropId: number;
  /** Prop id -> uses left per resource entry. */
  readonly propUses: readonly (readonly [number, readonly number[]])[];
  /** Prop id -> damage taken per part. */
  readonly propDamage: readonly (readonly [number, readonly number[]])[];
  /** Prop id -> bitmask of parts that have come off. */
  readonly propBroken: readonly (readonly [number, number])[];
}

export interface ContainerSave {
  readonly id: number;
  readonly columns: number;
  readonly rows: number;
  readonly slots: readonly (StackSave | null)[];
}

export interface TrampolineSave {
  readonly x: number;
  readonly baseY: number;
  readonly z: number;
}

export type { PieceSave };

export interface PickupSave {
  readonly item: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Flight direction of an embedded stick; absent for an ordinary drop. */
  readonly stuck?: readonly [number, number, number];
}

export interface WorldSave extends WorldEdits {
  readonly version: number;
  readonly savedAt: number;
  readonly containers: readonly ContainerSave[];
  readonly trampolines: readonly TrampolineSave[];
  readonly pieces: readonly PieceSave[];
  readonly pickups: readonly PickupSave[];
}

/** Most dropped items kept in a save; a pile any bigger is a mess nobody is coming back for. */
export const MAX_SAVED_PICKUPS = 500;
const MAX_TRAMPOLINES = 256;
const MAX_PIECES = 5_000;
const MAX_CONTAINERS = 20_000;
const MAX_PLACED_PROPS = 20_000;
/** Far beyond anywhere a player can reasonably be; a guard against NaN-adjacent garbage. */
const COORD_LIMIT = 1_000_000;

// -- primitives ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function record(raw: unknown): Json | undefined {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Json) : undefined;
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function finite(raw: unknown, min = -COORD_LIMIT, max = COORD_LIMIT): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? raw : undefined;
}

function whole(raw: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const value = finite(raw, min, max);
  return value !== undefined && Number.isInteger(value) ? value : undefined;
}

function knownItem(raw: unknown): string | undefined {
  return typeof raw === "string" && (ITEM_NAMES as readonly string[]).includes(raw) ? raw : undefined;
}

function stackOrNull(raw: unknown): StackSave | null {
  const r = record(raw);
  if (r === undefined) return null;
  const item = knownItem(r.item);
  const count = whole(r.count, 1, MAX_STACK);
  return item === undefined || count === undefined ? null : { item, count };
}

function slotList(raw: unknown, size: number): (StackSave | null)[] {
  const out: (StackSave | null)[] = [];
  const source = list(raw);
  for (let i = 0; i < size; i++) out.push(stackOrNull(source[i]));
  return out;
}

function pairs(raw: unknown, second: (value: unknown) => number | undefined): [number, number][] {
  const out: [number, number][] = [];
  for (const entry of list(raw)) {
    const [a, b] = list(entry);
    const key = whole(a);
    const value = second(b);
    if (key !== undefined && value !== undefined) out.push([key, value]);
  }
  return out;
}

function numberLists(raw: unknown, each: (value: unknown) => number | undefined): [number, number[]][] {
  const out: [number, number[]][] = [];
  for (const entry of list(raw)) {
    const [a, b] = list(entry);
    const key = whole(a);
    if (key === undefined) continue;
    const values: number[] = [];
    for (const v of list(b)) {
      const n = each(v);
      if (n !== undefined) values.push(n);
    }
    out.push([key, values]);
  }
  return out;
}

function wholeList(raw: unknown): number[] {
  const out: number[] = [];
  for (const v of list(raw)) {
    const n = whole(v);
    if (n !== undefined) out.push(n);
  }
  return out;
}

// -- player -------------------------------------------------------------------------------

/**
 * A `PlayerSave` from anything: the same object back with every field made safe, or
 * undefined if it is not a save at all (or is from a newer game than this one).
 */
export function sanitizePlayerSave(raw: unknown): PlayerSave | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const version = whole(r.version, 1);
  if (version === undefined || version > SAVE_VERSION) return undefined;

  const p = record(r.position);
  const x = finite(p?.x);
  const y = finite(p?.y);
  const z = finite(p?.z);
  const slots = slotList(r.slots, TOTAL_SLOTS);
  slots[0] = null;

  return {
    version: SAVE_VERSION,
    savedAt: finite(r.savedAt, 0) ?? 0,
    position: x !== undefined && y !== undefined && z !== undefined ? { x, y, z } : null,
    yaw: finite(r.yaw, -1e6, 1e6) ?? -90,
    pitch: finite(r.pitch, -89, 89) ?? 0,
    selected: whole(r.selected, 0, HOTBAR_SLOTS - 1) ?? 0,
    slots,
    seen: list(r.seen).flatMap((name) => knownItem(name) ?? []),
  };
}

// -- world --------------------------------------------------------------------------------

function sanitizePlacedProps(raw: unknown): PlacedPropSave[] {
  const out: PlacedPropSave[] = [];
  for (const entry of list(raw)) {
    if (out.length >= MAX_PLACED_PROPS) break;
    const r = record(entry);
    if (r === undefined) continue;
    const id = whole(r.id);
    const kind = typeof r.kind === "string" && Object.hasOwn(PROP_METRICS, r.kind) ? r.kind : undefined;
    const x = finite(r.x);
    const y = finite(r.y);
    const z = finite(r.z);
    const scale = finite(r.scale, 0.001, 1000);
    if (id === undefined || kind === undefined || x === undefined || y === undefined || z === undefined || scale === undefined) {
      continue;
    }
    out.push({
      id,
      kind,
      biome: whole(r.biome, 0, 255) ?? 0,
      x,
      y,
      z,
      yaw: finite(r.yaw, -1e4, 1e4) ?? 0,
      scale,
      fullScale: finite(r.fullScale, 0.001, 1000) ?? scale,
      loot: list(r.loot).filter((name): name is string => typeof name === "string").slice(0, 64),
      broken: whole(r.broken, 0, 0x7fffffff) ?? 0,
    });
  }
  return out;
}

function sanitizeContainers(raw: unknown): ContainerSave[] {
  const out: ContainerSave[] = [];
  for (const entry of list(raw)) {
    if (out.length >= MAX_CONTAINERS) break;
    const r = record(entry);
    if (r === undefined) continue;
    const id = whole(r.id);
    const columns = whole(r.columns, 1, 16);
    const rows = whole(r.rows, 1, 16);
    if (id === undefined || columns === undefined || rows === undefined) continue;
    out.push({ id, columns, rows, slots: slotList(r.slots, columns * rows) });
  }
  return out;
}

function sanitizePickups(raw: unknown): PickupSave[] {
  const out: PickupSave[] = [];
  for (const entry of list(raw)) {
    if (out.length >= MAX_SAVED_PICKUPS) break;
    const r = record(entry);
    if (r === undefined) continue;
    const item = knownItem(r.item);
    const x = finite(r.x);
    const y = finite(r.y);
    const z = finite(r.z);
    if (item === undefined || x === undefined || y === undefined || z === undefined) continue;
    const dir = list(r.stuck).map((v) => finite(v, -1.01, 1.01));
    const stuck =
      dir.length === 3 && dir.every((v) => v !== undefined) ? ([dir[0], dir[1], dir[2]] as [number, number, number]) : undefined;
    out.push(stuck === undefined ? { item, x, y, z } : { item, x, y, z, stuck });
  }
  return out;
}

function sanitizeTrampolines(raw: unknown): TrampolineSave[] {
  const out: TrampolineSave[] = [];
  for (const entry of list(raw)) {
    if (out.length >= MAX_TRAMPOLINES) break;
    const r = record(entry);
    const x = finite(r?.x);
    const baseY = finite(r?.baseY);
    const z = finite(r?.z);
    if (x !== undefined && baseY !== undefined && z !== undefined) out.push({ x, baseY, z });
  }
  return out;
}

function sanitizePieces(raw: unknown): PieceSave[] {
  const out: PieceSave[] = [];
  for (const entry of list(raw)) {
    if (out.length >= MAX_PIECES) break;
    const r = record(entry);
    if (r === undefined) continue;
    const item = knownItem(r.item);
    if (item === undefined) continue;
    const type = itemTypeFromName(item);
    if (type === undefined || pieceSpecOf(type) === undefined) continue;
    const x = finite(r.x);
    const y = finite(r.y);
    const z = finite(r.z);
    const qx = finite(r.qx, -1.01, 1.01);
    const qy = finite(r.qy, -1.01, 1.01);
    const qz = finite(r.qz, -1.01, 1.01);
    const qw = finite(r.qw, -1.01, 1.01);
    if (
      x === undefined ||
      y === undefined ||
      z === undefined ||
      qx === undefined ||
      qy === undefined ||
      qz === undefined ||
      qw === undefined
    ) {
      continue;
    }
    // Not a rotation at all (all zeros, say): stand it up straight rather than lose it.
    const length = Math.hypot(qx, qy, qz, qw);
    const unit = length > 0.5 ? length : 1;
    out.push({
      item,
      x,
      y,
      z,
      qx: length > 0.5 ? qx / unit : 0,
      qy: length > 0.5 ? qy / unit : 0,
      qz: length > 0.5 ? qz / unit : 0,
      qw: length > 0.5 ? qw / unit : 1,
      fixed: r.fixed === true,
    });
  }
  return out;
}

/** A `WorldSave` from anything, as {@link sanitizePlayerSave} is for a player. */
export function sanitizeWorldSave(raw: unknown): WorldSave | undefined {
  const r = record(raw);
  if (r === undefined) return undefined;
  const version = whole(r.version, 1);
  const seed = finite(r.seed, -0x80000000, 0xffffffff);
  if (version === undefined || version > SAVE_VERSION || seed === undefined) return undefined;

  const placedProps = sanitizePlacedProps(r.placedProps);
  const highestPlaced = placedProps.reduce((top, prop) => Math.max(top, prop.id), 0);
  return {
    version: SAVE_VERSION,
    savedAt: finite(r.savedAt, 0) ?? 0,
    seed,
    severedTrees: pairs(r.severedTrees, (v) => finite(v, 0, 1000)),
    strippedFoliage: pairs(r.strippedFoliage, (v) => whole(v, 0, 0x7fffffff)),
    strippedLights: wholeList(r.strippedLights),
    removedProps: wholeList(r.removedProps),
    placedProps,
    // Never hand out an id that is already taken, whatever the file claims.
    nextPlacedPropId: Math.max(whole(r.nextPlacedPropId) ?? 0, highestPlaced + 1),
    propUses: numberLists(r.propUses, (v) => whole(v, 0, 1_000_000)),
    propDamage: numberLists(r.propDamage, (v) => finite(v, 0, 1_000_000)),
    propBroken: pairs(r.propBroken, (v) => whole(v, 0, 0x7fffffff)),
    containers: sanitizeContainers(r.containers),
    trampolines: sanitizeTrampolines(r.trampolines),
    pieces: sanitizePieces(r.pieces),
    pickups: sanitizePickups(r.pickups),
  };
}
