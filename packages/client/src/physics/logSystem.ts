import { Quaternion, type BufferGeometry, type Object3D, type Scene } from "three/webgpu";

import { chunkKey, keyX, keyY, keyZ } from "@fgp/shared/sim/chunkKey";
import type { OrientedBody, SceneSolidQuery } from "@fgp/shared/sim/sceneQuery";
import { CHUNK_METERS, type World } from "@fgp/shared/sim/world";

import type { BodyHandle, PhysicsWorld } from "./physicsWorld.ts";

/**
 * Felled logs: the piece a chup cuts off a tree, as a falling rigid body
 * with the sliced piece of the tree's own mesh drawn on it.
 *
 * Terrain collision bodies are created here rather than globally, and only
 * for the chunks immediately around a log. Static mesh bodies are not free
 * to build, there are ~450 loaded chunks, and nothing but a log ever needs
 * one -- so they follow the logs around and are dropped the moment no log
 * is near them.
 */

/** Chunks either side of a log's own that get a collision body. */
const TERRAIN_BODY_RADIUS = 1;

/** Logs further than this from the player are dropped, mesh and body. */
const LOG_CULL_METERS = 48;

interface Log {
  readonly handle: BodyHandle;
  readonly object: Object3D;
  /** Geometry this log owns, sliced for it, and disposes when culled. */
  readonly owned: readonly BufferGeometry[];
  /**
   * The cylinder standing in for the piece, and the pose it is in. Handed
   * to the scene query once the log settles, which is what makes it
   * walkable.
   */
  readonly body: OrientedBody;
  settled: boolean;
}

export class LogSystem {
  private readonly logs: Log[] = [];
  private readonly transform = new Float32Array(7);
  private readonly wantedChunks = new Set<number>();
  private readonly rotation = new Quaternion();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: World,
    private readonly query: SceneSolidQuery,
    private readonly scene: Scene,
  ) {}

  get count(): number {
    return this.logs.length;
  }

  /**
   * Takes ownership of a cut piece. `object`'s origin is the piece's
   * centre, which is the point a rigid body's transform describes, and the
   * cylinder is what collision and walking see of it.
   */
  spawn(
    object: Object3D,
    owned: readonly BufferGeometry[],
    x: number,
    y: number,
    z: number,
    radius: number,
    halfHeight: number,
  ): void {
    // Terrain bodies first: a log spawned into a world with no collision
    // under it falls through before the next sync can catch it.
    this.markWanted(x, y, z);
    this.syncTerrainBodies();

    const handle = this.physics.spawnCapsule(x, y, z, radius, halfHeight, true);
    if (handle === undefined) {
      for (const geometry of owned) geometry.dispose();
      return;
    }

    object.position.set(x, y, z);
    this.scene.add(object);
    this.logs.push({
      handle,
      object,
      owned,
      body: { radius, halfHeight, x, y, z, qx: 0, qy: 0, qz: 0, qw: 1 },
      settled: false,
    });
  }

  /** Drives mesh transforms off the bodies and keeps terrain bodies around them. */
  update(playerX: number, playerY: number, playerZ: number): void {
    this.wantedChunks.clear();
    // Rebuilt from scratch each frame rather than patched: the list is a
    // handful of entries, and a log that woke up has to leave it the same
    // frame or the player stands on a log that is no longer there.
    this.query.bodies.length = 0;

    for (let i = this.logs.length - 1; i >= 0; i--) {
      const log = this.logs[i];
      if (log === undefined) continue;

      if (!this.physics.readTransform(log.handle, this.transform)) continue;
      const x = this.transform[0] ?? 0;
      const y = this.transform[1] ?? 0;
      const z = this.transform[2] ?? 0;

      if (Math.hypot(x - playerX, y - playerY, z - playerZ) > LOG_CULL_METERS) {
        this.remove(log);
        this.logs.splice(i, 1);
        continue;
      }

      log.object.position.set(x, y, z);
      log.body.x = x;
      log.body.y = y;
      log.body.z = z;
      log.body.qx = this.transform[3] ?? 0;
      log.body.qy = this.transform[4] ?? 0;
      log.body.qz = this.transform[5] ?? 0;
      log.body.qw = this.transform[6] ?? 1;
      this.rotation.set(
        this.transform[3] ?? 0,
        this.transform[4] ?? 0,
        this.transform[5] ?? 0,
        this.transform[6] ?? 1,
      );
      log.object.quaternion.copy(this.rotation);

      // A sleeping log needs no terrain under it, so its chunk bodies are
      // allowed to go away until something wakes it.
      log.settled = !this.physics.isActive(log.handle);
      if (log.settled) {
        // Only settled logs are walkable. A tumbling one would mean the
        // player's feet chasing a moving surface the physics system does
        // not know about, which reads as being thrown around.
        this.query.bodies.push(log.body);
      } else {
        this.markWanted(x, y, z);
      }
    }

    this.syncTerrainBodies();
  }

  /** Marks the chunks around a point as needing a collision body. */
  private markWanted(x: number, y: number, z: number): void {
    const cx = Math.floor(x / CHUNK_METERS);
    const cy = Math.floor(y / CHUNK_METERS);
    const cz = Math.floor(z / CHUNK_METERS);
    for (let dz = -TERRAIN_BODY_RADIUS; dz <= TERRAIN_BODY_RADIUS; dz++) {
      for (let dy = -TERRAIN_BODY_RADIUS; dy <= TERRAIN_BODY_RADIUS; dy++) {
        for (let dx = -TERRAIN_BODY_RADIUS; dx <= TERRAIN_BODY_RADIUS; dx++) {
          this.wantedChunks.add(chunkKey(cx + dx, cy + dy, cz + dz));
        }
      }
    }
  }

  /** Creates bodies for every wanted chunk and drops the rest. */
  private syncTerrainBodies(): void {
    for (const key of this.wantedChunks) {
      if (this.physics.hasTerrainBody(key)) continue;
      const cx = keyX(key);
      const cy = keyY(key);
      const cz = keyZ(key);
      const mesh = this.world.meshChunk(cx, cy, cz);
      if (mesh === undefined) continue;
      this.physics.addTerrainBody(
        key,
        cx * CHUNK_METERS,
        cy * CHUNK_METERS,
        cz * CHUNK_METERS,
        mesh.vertices,
        mesh.vertexCount,
      );
    }

    for (const key of this.physics.terrainBodyKeys()) {
      if (!this.wantedChunks.has(key)) this.physics.removeTerrainBody(key);
    }
  }

  private remove(log: Log): void {
    this.physics.removeBody(log.handle);
    this.scene.remove(log.object);
    for (const geometry of log.owned) geometry.dispose();
  }

  clear(): void {
    for (const log of this.logs) this.remove(log);
    this.logs.length = 0;
  }
}
