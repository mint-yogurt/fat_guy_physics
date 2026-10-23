import { Quaternion, Vector3, type Object3D, type Scene } from "three/webgpu";

import { createBuildHit, type BuildField } from "@fgp/shared/items/building";
import { ItemType } from "@fgp/shared/items/inventory";
import type { PickupField } from "@fgp/shared/items/pickupField";
import { TRAMPOLINE_RADIUS, TRAMPOLINE_RESTITUTION, type TrampolineField } from "@fgp/shared/items/trampoline";
import { VOXEL_SIZE } from "@fgp/shared/sim/constants";
import { createSceneHit, HitKind, type World } from "@fgp/shared/sim/world";

import { STICK_LENGTH, type ItemAssets } from "../render/itemAssets.ts";
import { createPieceHit, type LogSystem } from "./logSystem.ts";

/**
 * Sticks in flight, thrown like a spear. Ports the C++ build's
 * ThrownStick/updateThrownSticks.
 *
 * A stick flies business end (the fork) first on plain gravity, swept as a
 * segment against the scene each frame so a fast throw cannot step through
 * a thin trunk. What it hits decides what it becomes:
 *
 *  - ground or a standing tree: it goes in, and stays there at the angle it
 *    hit, as a stuck pickup -- walk up and press E to pull it out;
 *  - a felled piece: it shoves the piece and falls off as a loose pickup;
 *  - a prop: it bounces off and falls;
 *  - a trampoline mat: it springs back up off it, losing only what the mat does.
 *
 * A stick that flies for too long without hitting anything drops where it is.
 */

const GRAVITY = -9;
/** How far the fork sinks into what it hits, metres. */
const EMBED_DEPTH = 0.18;
const MAX_FLIGHT_SECONDS = 8;
/** Momentum handed to a piece the stick hits, as a multiple of the stick's velocity. */
const SHOVE = 6;

interface Flying {
  readonly object: Object3D;
  /** The fork's tip. */
  readonly tip: Vector3;
  readonly velocity: Vector3;
  age: number;
}

const Z_AXIS = new Vector3(0, 0, 1);
const dir = new Vector3();
const rotation = new Quaternion();

export type StickHit = "log" | "mat" | "prop" | "ground";

export class ThrownSticks {
  /**
   * Called where a stick hits something and stops: a point, and what it hit
   * (and which prop, when it was a prop).
   */
  onHit: ((x: number, y: number, z: number, hit: StickHit, propId: number) => void) | undefined = undefined;
  private readonly flying: Flying[] = [];
  private readonly sceneHit = createSceneHit();
  private readonly pieceHit = createPieceHit();
  private readonly buildHit = createBuildHit();

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
    private readonly world: World,
    private readonly pickups: PickupField,
    private readonly trampolines: TrampolineField,
    private readonly pieces: BuildField,
  ) {}

  get count(): number {
    return this.flying.length;
  }

  /**
   * Launches a stick from `from` (the eye) with its tip at `tip`. The span
   * between the two is swept first, so a throw with the fork already in a
   * wall sticks into the wall instead of starting on its far side.
   */
  throw(
    fromX: number,
    fromY: number,
    fromZ: number,
    tipX: number,
    tipY: number,
    tipZ: number,
    vx: number,
    vy: number,
    vz: number,
    logs: LogSystem | undefined,
    now: number,
  ): void {
    const stick: Flying = {
      object: this.assets.stick.clone(),
      tip: new Vector3(fromX, fromY, fromZ),
      velocity: new Vector3(vx, vy, vz),
      age: 0,
    };
    if (this.sweep(stick, tipX - fromX, tipY - fromY, tipZ - fromZ, logs, now)) return;
    this.scene.add(stick.object);
    this.place(stick);
    this.flying.push(stick);
  }

  update(dt: number, logs: LogSystem | undefined, now: number): void {
    for (let i = this.flying.length - 1; i >= 0; i--) {
      const stick = this.flying[i];
      if (stick === undefined) continue;
      stick.age += dt;
      stick.velocity.y += GRAVITY * dt;
      const v = stick.velocity;
      let done = this.sweep(stick, v.x * dt, v.y * dt, v.z * dt, logs, now);
      if (!done && stick.age > MAX_FLIGHT_SECONDS) {
        this.dropLoose(stick.tip, now, 0, 0, 0);
        done = true;
      }
      if (done) {
        this.scene.remove(stick.object);
        this.flying.splice(i, 1);
      } else {
        this.place(stick);
      }
    }
  }

  /**
   * Moves the tip along (dx, dy, dz), stopping at the first thing in the
   * way. True if the stick hit something and is no longer flying.
   */
  private sweep(
    stick: Flying,
    dx: number,
    dy: number,
    dz: number,
    logs: LogSystem | undefined,
    now: number,
  ): boolean {
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-6) return false;
    const ux = dx / length;
    const uy = dy / length;
    const uz = dz / length;
    const tip = stick.tip;

    const scene = this.world.raycastScene(tip.x, tip.y, tip.z, ux, uy, uz, length, this.sceneHit);
    const sceneDistance = scene.kind === HitKind.None ? Infinity : scene.distance;
    const piece = logs?.raycast(tip.x, tip.y, tip.z, ux, uy, uz, length, this.pieceHit);
    const pieceDistance = piece?.piece === undefined ? Infinity : piece.distance;

    // A placed building piece (a ladder, a plank) is neither in the voxels nor
    // the log system: a stick hitting one bounces off and falls.
    this.pieces.raycast(tip.x, tip.y, tip.z, ux, uy, uz, Math.min(length, sceneDistance, pieceDistance), this.buildHit);
    if (this.buildHit.piece !== undefined) {
      const v = stick.velocity;
      tip.set(this.buildHit.x - ux * 0.05, this.buildHit.y - uy * 0.05, this.buildHit.z - uz * 0.05);
      this.onHit?.(tip.x, tip.y, tip.z, "log", -1);
      this.dropLoose(tip, now, -v.x * 0.15, 1, -v.z * 0.15);
      return true;
    }

    if (pieceDistance < sceneDistance && piece?.piece !== undefined && logs !== undefined) {
      const v = stick.velocity;
      logs.shove(piece.piece, v.x * SHOVE, v.y * SHOVE, v.z * SHOVE);
      tip.set(piece.x - ux * 0.1, piece.y - uy * 0.1, piece.z - uz * 0.1);
      this.onHit?.(tip.x, tip.y, tip.z, "log", -1);
      this.dropLoose(tip, now, -v.x * 0.15, 1, -v.z * 0.15);
      return true;
    }

    // A mat is not in the world's voxels or the log system, so it is its own
    // test: where the segment crosses the mat's plane, if that is on the mat.
    if (uy < 0) {
      for (const mat of this.trampolines.items) {
        const along = (mat.topY - tip.y) / uy;
        if (along < 0 || along > length || along >= sceneDistance) continue;
        const hitX = tip.x + ux * along;
        const hitZ = tip.z + uz * along;
        if (Math.hypot(hitX - mat.x, hitZ - mat.z) > TRAMPOLINE_RADIUS) continue;
        const v = stick.velocity;
        tip.set(hitX, mat.topY, hitZ);
        this.onHit?.(hitX, mat.topY, hitZ, "mat", -1);
        this.dropLoose(tip, now, v.x * 0.5, -v.y * TRAMPOLINE_RESTITUTION, v.z * 0.5);
        return true;
      }
    }

    if (sceneDistance <= length) {
      tip.set(tip.x + ux * sceneDistance, tip.y + uy * sceneDistance, tip.z + uz * sceneDistance);
      if (scene.kind === HitKind.Prop) {
        this.onHit?.(tip.x, tip.y, tip.z, "prop", scene.propId);
        const v = stick.velocity;
        this.dropLoose(tip, now, -v.x * 0.15, 1, -v.z * 0.15);
        return true;
      }
      // Terrain and trunks: in it goes, along the line it was flying.
      this.onHit?.(tip.x, tip.y, tip.z, "ground", -1);
      const embed = EMBED_DEPTH + VOXEL_SIZE * 0.5;
      const buttX = tip.x + ux * embed - ux * STICK_LENGTH;
      const buttY = tip.y + uy * embed - uy * STICK_LENGTH;
      const buttZ = tip.z + uz * embed - uz * STICK_LENGTH;
      this.pickups.spawnStuck(ItemType.Stick, buttX, buttY, buttZ, ux, uy, uz, now);
      return true;
    }

    tip.set(tip.x + dx, tip.y + dy, tip.z + dz);
    return false;
  }

  private dropLoose(at: Vector3, now: number, vx: number, vy: number, vz: number): void {
    const groundY = Math.max(
      this.world.surfaceHeightVoxels(Math.floor(at.x / VOXEL_SIZE), Math.floor(at.z / VOXEL_SIZE)) *
        VOXEL_SIZE,
      this.trampolines.topAt(at.x, at.z) ?? -Infinity,
    );
    this.pickups.spawn(ItemType.Stick, at.x, at.y, at.z, groundY, now, vx, vy, vz);
  }

  /** Lines the mesh up with the flight, butt trailing the tip. */
  private place(stick: Flying): void {
    dir.copy(stick.velocity).normalize();
    stick.object.quaternion.copy(rotation.setFromUnitVectors(Z_AXIS, dir));
    stick.object.position.copy(stick.tip).addScaledVector(dir, -STICK_LENGTH);
  }

  clear(): void {
    for (const stick of this.flying) this.scene.remove(stick.object);
    this.flying.length = 0;
  }
}
