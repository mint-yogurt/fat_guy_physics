import type { Object3D, Scene } from "three/webgpu";

/**
 * Pieces of the world knocked off and flung: a snowman's head, say. Each is
 * an object launched on plain gravity that ends, on the ground or when its
 * time is up, by reporting where, so the caller can burst it into whatever it
 * is made of.
 */

const GRAVITY = 9.8;
/** It goes off in the air if it has not landed by now, seconds. */
const MAX_FLIGHT_SECONDS = 0.5;

interface Chunk {
  readonly object: Object3D;
  /** Its own size, so it bursts when its underside meets the ground. */
  readonly radius: number;
  vx: number;
  vy: number;
  vz: number;
  readonly spinX: number;
  readonly spinZ: number;
  age: number;
  readonly onDone: (x: number, y: number, z: number) => void;
}

export class FlyingChunks {
  private readonly chunks: Chunk[] = [];

  constructor(private readonly scene: Scene) {}

  get count(): number {
    return this.chunks.length;
  }

  /** Sends `object` (already positioned at its middle) off at the given velocity, spinning. */
  launch(
    object: Object3D,
    radius: number,
    vx: number,
    vy: number,
    vz: number,
    onDone: (x: number, y: number, z: number) => void,
  ): void {
    this.scene.add(object);
    this.chunks.push({
      object,
      radius,
      vx,
      vy,
      vz,
      spinX: (Math.random() - 0.5) * 9,
      spinZ: (Math.random() - 0.5) * 9,
      age: 0,
      onDone,
    });
  }

  update(dt: number, groundAt: (x: number, z: number) => number): void {
    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i] as Chunk;
      const { object } = chunk;
      chunk.age += dt;
      chunk.vy -= GRAVITY * dt;
      object.position.x += chunk.vx * dt;
      object.position.y += chunk.vy * dt;
      object.position.z += chunk.vz * dt;
      object.rotation.x += chunk.spinX * dt;
      object.rotation.z += chunk.spinZ * dt;
      const landed = object.position.y - chunk.radius * 0.5 <= groundAt(object.position.x, object.position.z);
      if (landed || chunk.age >= MAX_FLIGHT_SECONDS) {
        this.scene.remove(object);
        this.chunks.splice(i, 1);
        chunk.onDone(object.position.x, object.position.y, object.position.z);
      }
    }
  }

  clear(): void {
    for (const chunk of this.chunks) this.scene.remove(chunk.object);
    this.chunks.length = 0;
  }
}
