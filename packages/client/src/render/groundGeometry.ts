import { BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from "three/webgpu";

import {
  GROUND_FLOATS_PER_VERTEX,
  OFFSET_NORMAL,
  OFFSET_POSITION,
  OFFSET_SHADE,
  OFFSET_SPOOKY,
  OFFSET_TINT,
  OFFSET_WEIGHTS,
} from "@fgp/shared/worldgen/groundMesh";

/**
 * Turns a ground tile's interleaved vertex buffer into a BufferGeometry.
 *
 * `vertices` is taken by reference, not copied: it arrives from a chunk worker as a
 * transferable and already belongs to this thread, sized exactly to `vertexCount`.
 */
export function createGroundGeometry(vertices: Float32Array, vertexCount: number): BufferGeometry {
  const geometry = new BufferGeometry();
  const interleaved = new InterleavedBuffer(vertices, GROUND_FLOATS_PER_VERTEX);

  geometry.setAttribute("position", new InterleavedBufferAttribute(interleaved, 3, OFFSET_POSITION));
  geometry.setAttribute("normal", new InterleavedBufferAttribute(interleaved, 3, OFFSET_NORMAL));
  geometry.setAttribute("groundWeights", new InterleavedBufferAttribute(interleaved, 3, OFFSET_WEIGHTS));
  geometry.setAttribute("groundTint", new InterleavedBufferAttribute(interleaved, 3, OFFSET_TINT));
  geometry.setAttribute("groundShade", new InterleavedBufferAttribute(interleaved, 1, OFFSET_SHADE));
  geometry.setAttribute("groundSpooky", new InterleavedBufferAttribute(interleaved, 1, OFFSET_SPOOKY));

  geometry.setDrawRange(0, vertexCount);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Releases GPU resources. Materials are shared across tiles and are deliberately not touched.
 * Streaming creates and destroys these constantly, and three.js does not free GPU buffers on
 * garbage collection.
 */
export function disposeGroundGeometry(geometry: BufferGeometry): void {
  geometry.dispose();
}
