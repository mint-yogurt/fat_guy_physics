import { Mesh, Quaternion, type Material, type Scene } from "three/webgpu";

import { chunkKey, keyX, keyY, keyZ } from "@fgp/shared/sim/chunkKey";
import { VOXEL_SIZE } from "@fgp/shared/sim/constants";
import { CHUNK_METERS, type World } from "@fgp/shared/sim/world";
import { Mesher } from "@fgp/shared/voxel/greedyMesher";
import type { VoxelGrid } from "@fgp/shared/voxel/voxelGrid";

import { createChunkGeometry, disposeChunkGeometry } from "../render/chunkGeometry.ts";
import type { BodyHandle, PhysicsWorld } from "./physicsWorld.ts";

/**
 * Felled logs: the piece a chup cuts off a tree, as a falling rigid body
 * with the piece's own voxels drawn on it.
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
  readonly mesh: Mesh;
  /** Kept for M8: walking on a settled log needs its voxels back. */
  readonly grid: VoxelGrid;
  settled: boolean;
}

export class LogSystem {
  private readonly logs: Log[] = [];
  private readonly mesher = new Mesher();
  private readonly transform = new Float32Array(7);
  private readonly wantedChunks = new Set<number>();
  private readonly rotation = new Quaternion();

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly world: World,
    private readonly scene: Scene,
    private readonly material: Material,
  ) {}

  get count(): number {
    return this.logs.length;
  }

  /**
   * Takes ownership of a severed piece. `centerX/Y/Z` is where its local
   * origin sits in the world, which severGridAt already arranged to be the
   * piece's own centre.
   */
  spawn(
    piece: VoxelGrid,
    centerX: number,
    centerY: number,
    centerZ: number,
    radiusMeters: number,
  ): void {
    // Terrain bodies first: a log spawned into a world with no collision
    // under it falls through before the next sync can catch it.
    this.markWanted(centerX, centerY, centerZ);
    this.syncTerrainBodies();

    const halfHeight = Math.max(0.05, (piece.dimY * VOXEL_SIZE) / 2 - radiusMeters);
    const handle = this.physics.spawnCapsule(
      centerX,
      centerY,
      centerZ,
      radiusMeters,
      halfHeight,
      true,
    );
    if (handle === undefined) return;

    const mesh = this.mesher.mesh(piece);
    if (mesh.vertexCount === 0) {
      this.physics.removeBody(handle);
      return;
    }

    const object = new Mesh(
      createChunkGeometry(mesh.vertices.slice(0, mesh.vertices.length), mesh.vertexCount),
      this.material,
    );
    object.position.set(centerX, centerY, centerZ);
    this.scene.add(object);
    this.logs.push({ handle, mesh: object, grid: piece, settled: false });
  }

  /** Drives mesh transforms off the bodies and keeps terrain bodies around them. */
  update(playerX: number, playerY: number, playerZ: number): void {
    this.wantedChunks.clear();

    for (let i = this.logs.length - 1; i >= 0; i--) {
      const log = this.logs[i];
      if (log === undefined) continue;

      if (!this.physics.readTransform(log.handle, this.transform)) continue;
      const x = this.transform[0] ?? 0;
      const y = this.transform[1] ?? 0;
      const z = this.transform[2] ?? 0;

      if (Math.hypot(x - playerX, y - playerY, z - playerZ) > LOG_CULL_METERS) {
        this.physics.removeBody(log.handle);
        this.scene.remove(log.mesh);
        disposeChunkGeometry(log.mesh.geometry);
        this.logs.splice(i, 1);
        continue;
      }

      log.mesh.position.set(x, y, z);
      this.rotation.set(
        this.transform[3] ?? 0,
        this.transform[4] ?? 0,
        this.transform[5] ?? 0,
        this.transform[6] ?? 1,
      );
      log.mesh.quaternion.copy(this.rotation);

      // A sleeping log needs no terrain under it, so its chunk bodies are
      // allowed to go away until something wakes it.
      log.settled = !this.physics.isActive(log.handle);
      if (!log.settled) this.markWanted(x, y, z);
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

  clear(): void {
    for (const log of this.logs) {
      this.physics.removeBody(log.handle);
      this.scene.remove(log.mesh);
      disposeChunkGeometry(log.mesh.geometry);
    }
    this.logs.length = 0;
  }
}
