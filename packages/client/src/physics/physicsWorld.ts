import initJolt from "jolt-physics";
import type Jolt from "jolt-physics";

import { FLOATS_PER_VERTEX } from "@fgp/shared/voxel/vertexLayout";

/**
 * Rigid-body physics: the Emscripten build of the same Jolt the native
 * client uses, so this wraps the same calls src/physics/PhysicsWorld.cpp
 * does.
 *
 * Scope is deliberately narrow and matches the C++'s: the *player* stays on
 * the hand-tuned voxel sweep in @fgp/shared/sim/collision, which is a known
 * quantity that took a long time to get right. Jolt is additive, for things
 * that tumble -- felled logs now, debris and props later.
 *
 * Terrain is static mesh bodies built from the greedy mesher's own
 * triangles, one per chunk, created only for chunks near something dynamic.
 * There are hundreds of loaded chunks and at most a handful of falling
 * objects, so building bodies for all of them would be most of a second of
 * work to support nothing. A heightfield was rejected for the same reason
 * the C++ rejected it: digging carves overhangs a one-height-per-column
 * field cannot represent.
 *
 * This lives in the client rather than @fgp/shared because the Jolt module
 * loads WASM, which the shared package's deliberately browser-free
 * environment has no way to do. The authoritative server will need its own
 * instance of it at M14; the data it operates on (voxel grids, transforms)
 * is already shared.
 */

const LAYER_STATIC = 0;
const LAYER_DYNAMIC = 1;
const LAYER_COUNT = 2;

/** Wood is a bit under water; this is the C++'s density for felled logs. */
const WOOD_DENSITY = 600;

/**
 * How fast a felled piece starts to tip, rad/s. A piece cut from a standing
 * trunk rests on the flat top of its own stump, which is a real (if
 * unstable) equilibrium Jolt is happy to leave it balanced in. An angular
 * *impulse* is the wrong tool for the nudge: the same impulse that tips a
 * branch does nothing to a 400kg trunk. A velocity tips both alike.
 */
const TOPPLE_SPIN = 0.9;

export type BodyHandle = number;

export class PhysicsWorld {
  private readonly jolt: typeof Jolt & Record<string, unknown>;
  private readonly joltInterface: Jolt.JoltInterface;
  private readonly bodyInterface: Jolt.BodyInterface;
  private readonly bodies = new Map<BodyHandle, Jolt.BodyID>();
  private readonly terrainBodies = new Map<number, Jolt.BodyID>();
  /** Static trunk cylinders, keyed by tree id, with the height each was built at. */
  private readonly trunkBodies = new Map<number, { id: Jolt.BodyID; height: number }>();

  /** Scratch, so reading a transform per frame allocates nothing. */
  private readonly scratchVec: Jolt.Vec3;
  private readonly scratchQuat: Jolt.Quat;

  private constructor(joltModule: unknown) {
    const J = joltModule as typeof Jolt & Record<string, unknown>;
    this.jolt = J;

    const settings = new J.JoltSettings();

    // Two layers, the minimum that works: static terrain that never
    // collides with itself, and everything dynamic.
    const objectFilter = new J.ObjectLayerPairFilterTable(LAYER_COUNT);
    objectFilter.EnableCollision(LAYER_STATIC, LAYER_DYNAMIC);
    objectFilter.EnableCollision(LAYER_DYNAMIC, LAYER_DYNAMIC);

    const bpInterface = new J.BroadPhaseLayerInterfaceTable(LAYER_COUNT, LAYER_COUNT);
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_STATIC, new J.BroadPhaseLayer(LAYER_STATIC));
    bpInterface.MapObjectToBroadPhaseLayer(LAYER_DYNAMIC, new J.BroadPhaseLayer(LAYER_DYNAMIC));

    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = bpInterface;
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(
      settings.mBroadPhaseLayerInterface,
      LAYER_COUNT,
      settings.mObjectLayerPairFilter,
      LAYER_COUNT,
    );

    this.joltInterface = new J.JoltInterface(settings);
    J.destroy(settings);

    this.bodyInterface = this.joltInterface.GetPhysicsSystem().GetBodyInterface();
    this.scratchVec = new J.Vec3(0, 0, 0);
    this.scratchQuat = new J.Quat(0, 0, 0, 1);
  }

  static async create(): Promise<PhysicsWorld> {
    return new PhysicsWorld(await initJolt());
  }

  /** One fixed substep, called from the same accumulator the player uses. */
  step(dt: number): void {
    // One collision step per substep: the substep is already 1/120s, which
    // is well inside Jolt's recommended maximum.
    this.joltInterface.Step(dt, 1);
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  get terrainBodyCount(): number {
    return this.terrainBodies.size;
  }

  hasTerrainBody(key: number): boolean {
    return this.terrainBodies.has(key);
  }

  /** Snapshot, so the caller may remove bodies while iterating. */
  terrainBodyKeys(): number[] {
    return [...this.terrainBodies.keys()];
  }

  /**
   * Adds a static body for one chunk, built from its greedy mesh.
   *
   * `vertices` is the interleaved layout the mesher emits, with positions
   * chunk-local, so the body is placed at the chunk's world origin.
   */
  addTerrainBody(
    key: number,
    originX: number,
    originY: number,
    originZ: number,
    vertices: Float32Array,
    vertexCount: number,
  ): void {
    if (this.terrainBodies.has(key)) return;
    // An empty chunk (solid rock or open air) has nothing to collide with.
    if (vertexCount < 3) return;

    const J = this.jolt;
    const triangleCount = Math.floor(vertexCount / 3);
    const triangles = new J.TriangleList();
    triangles.resize(triangleCount);

    for (let t = 0; t < triangleCount; t++) {
      const triangle = triangles.at(t);
      for (let corner = 0; corner < 3; corner++) {
        const base = (t * 3 + corner) * FLOATS_PER_VERTEX;
        const v = triangle.get_mV(corner);
        v.x = vertices[base] ?? 0;
        v.y = vertices[base + 1] ?? 0;
        v.z = vertices[base + 2] ?? 0;
      }
    }

    const materials = new J.PhysicsMaterialList();
    const shapeResult = new J.MeshShapeSettings(triangles, materials).Create();
    J.destroy(triangles);
    J.destroy(materials);
    if (shapeResult.HasError()) return;

    const shape = shapeResult.Get();
    const creation = new J.BodyCreationSettings(
      shape,
      new J.RVec3(originX, originY, originZ),
      new J.Quat(0, 0, 0, 1),
      J.EMotionType_Static,
      LAYER_STATIC,
    );
    const body = this.bodyInterface.CreateBody(creation);
    J.destroy(creation);

    this.bodyInterface.AddBody(body.GetID(), J.EActivation_DontActivate);
    this.terrainBodies.set(key, body.GetID());
  }

  removeTerrainBody(key: number): void {
    const id = this.terrainBodies.get(key);
    if (id === undefined) return;
    this.terrainBodies.delete(key);
    this.bodyInterface.RemoveBody(id);
    this.bodyInterface.DestroyBody(id);
  }

  /**
   * A static upright cylinder for a standing trunk or stump, so a falling
   * piece lands on the stump it was cut from rather than through it.
   * Rebuilt when the trunk has been cut shorter since.
   */
  setTrunkBody(treeId: number, x: number, baseY: number, z: number, radius: number, height: number): void {
    const existing = this.trunkBodies.get(treeId);
    if (existing !== undefined) {
      if (existing.height === height) return;
      this.removeTrunkBody(treeId);
    }
    if (height <= 0.02) return;

    const J = this.jolt;
    const half = height / 2;
    const shape = new J.CylinderShapeSettings(half, radius, Math.min(0.05, radius * 0.5, half)).Create();
    if (shape.HasError()) return;
    const creation = new J.BodyCreationSettings(
      shape.Get(),
      new J.RVec3(x, baseY + half, z),
      new J.Quat(0, 0, 0, 1),
      J.EMotionType_Static,
      LAYER_STATIC,
    );
    const body = this.bodyInterface.CreateBody(creation);
    J.destroy(creation);
    this.bodyInterface.AddBody(body.GetID(), J.EActivation_DontActivate);
    this.trunkBodies.set(treeId, { id: body.GetID(), height });
  }

  /** Snapshot, so the caller may remove bodies while iterating. */
  trunkBodyIds(): number[] {
    return [...this.trunkBodies.keys()];
  }

  removeTrunkBody(treeId: number): void {
    const entry = this.trunkBodies.get(treeId);
    if (entry === undefined) return;
    this.trunkBodies.delete(treeId);
    this.bodyInterface.RemoveBody(entry.id);
    this.bodyInterface.DestroyBody(entry.id);
  }

  /**
   * A dynamic capsule along its own Y axis, in the given rotation -- the
   * shape a felled piece gets, matching PhysicsWorld::spawnCapsuleBody.
   * `toppleX/Z` is a horizontal axis to start it spinning about, or zero
   * for none.
   */
  spawnCapsule(
    x: number,
    y: number,
    z: number,
    radius: number,
    halfHeight: number,
    rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
    toppleX = 0,
    toppleZ = 0,
  ): BodyHandle | undefined {
    const J = this.jolt;
    const shape = new J.CapsuleShapeSettings(Math.max(halfHeight, 0.01), radius).Create();
    if (shape.HasError()) return undefined;

    const creation = new J.BodyCreationSettings(
      shape.Get(),
      new J.RVec3(x, y, z),
      new J.Quat(rotation[0], rotation[1], rotation[2], rotation[3]),
      J.EMotionType_Dynamic,
      LAYER_DYNAMIC,
    );
    creation.mOverrideMassProperties = J.EOverrideMassProperties_CalculateInertia;
    creation.mMassPropertiesOverride.mMass =
      Math.PI * radius * radius * (halfHeight * 2 + radius * 2) * WOOD_DENSITY;
    const body = this.bodyInterface.CreateBody(creation);
    J.destroy(creation);

    const id = body.GetID();
    this.bodyInterface.AddBody(id, J.EActivation_Activate);

    if (toppleX !== 0 || toppleZ !== 0) {
      const length = Math.hypot(toppleX, toppleZ);
      this.scratchVec.Set((toppleX / length) * TOPPLE_SPIN, 0, (toppleZ / length) * TOPPLE_SPIN);
      this.bodyInterface.SetAngularVelocity(id, this.scratchVec);
    }

    const handle = id.GetIndexAndSequenceNumber();
    this.bodies.set(handle, id);
    return handle;
  }

  /** A shove at the body's centre, N*s -- what a thrown stick does to a log it hits. */
  addImpulse(handle: BodyHandle, ix: number, iy: number, iz: number): void {
    const id = this.bodies.get(handle);
    if (id === undefined) return;
    this.scratchVec.Set(ix, iy, iz);
    this.bodyInterface.AddImpulse(id, this.scratchVec);
  }

  removeBody(handle: BodyHandle): void {
    const id = this.bodies.get(handle);
    if (id === undefined) return;
    this.bodies.delete(handle);
    this.bodyInterface.RemoveBody(id);
    this.bodyInterface.DestroyBody(id);
  }

  isActive(handle: BodyHandle): boolean {
    const id = this.bodies.get(handle);
    if (id === undefined) return false;
    return this.bodyInterface.IsActive(id);
  }

  /** Writes a body's pose into the caller's array as [x,y,z, qx,qy,qz,qw]. */
  readTransform(handle: BodyHandle, out: Float32Array): boolean {
    const id = this.bodies.get(handle);
    if (id === undefined) return false;
    const position = this.bodyInterface.GetPosition(id);
    const rotation = this.bodyInterface.GetRotation(id);
    out[0] = position.GetX();
    out[1] = position.GetY();
    out[2] = position.GetZ();
    out[3] = rotation.GetX();
    out[4] = rotation.GetY();
    out[5] = rotation.GetZ();
    out[6] = rotation.GetW();
    return true;
  }

  dispose(): void {
    for (const handle of [...this.bodies.keys()]) this.removeBody(handle);
    for (const key of [...this.terrainBodies.keys()]) this.removeTerrainBody(key);
    for (const treeId of [...this.trunkBodies.keys()]) this.removeTrunkBody(treeId);
    this.jolt.destroy(this.scratchVec);
    this.jolt.destroy(this.scratchQuat);
    this.jolt.destroy(this.joltInterface);
  }
}
