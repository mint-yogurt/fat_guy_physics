import { BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from "three/webgpu";

import {
  FLOATS_PER_VERTEX,
  OFFSET_COLOR,
  OFFSET_NORMAL,
  OFFSET_POSITION,
  OFFSET_UV,
} from "@fgp/shared/voxel/vertexLayout";

/**
 * Turns an interleaved vertex buffer into a three.js BufferGeometry.
 * Replaces src/voxel/ChunkMesh.{hpp,cpp}, which was raw VAO/VBO management.
 *
 * `vertices` is taken by reference, not copied: it arrives from a chunk
 * worker as a transferable and already belongs to this thread, sized exactly
 * to `vertexCount`. Anything that still owns a reusable scratch buffer must
 * copy before calling.
 */
export function createChunkGeometry(vertices: Float32Array, vertexCount: number): BufferGeometry {
  const geometry = new BufferGeometry();
  applyMeshData(geometry, vertices, vertexCount);
  return geometry;
}

/**
 * Replaces a geometry's contents in place.
 *
 * Reallocates rather than updating: an edited chunk's vertex count changes
 * (digging removes faces and exposes others), so the buffer genuinely has to
 * be resized. Growing into a pre-sized buffer and using `needsUpdate` is the
 * optimisation to reach for if remeshing ever shows up in a profile -- it is
 * not worth the bookkeeping until it does.
 */
export function applyMeshData(
  geometry: BufferGeometry,
  vertices: Float32Array,
  vertexCount: number,
): void {
  const interleaved = new InterleavedBuffer(vertices, FLOATS_PER_VERTEX);

  geometry.setAttribute(
    "position",
    new InterleavedBufferAttribute(interleaved, 3, OFFSET_POSITION),
  );
  geometry.setAttribute("color", new InterleavedBufferAttribute(interleaved, 3, OFFSET_COLOR));
  geometry.setAttribute("uv", new InterleavedBufferAttribute(interleaved, 2, OFFSET_UV));
  geometry.setAttribute("normal", new InterleavedBufferAttribute(interleaved, 3, OFFSET_NORMAL));

  geometry.setDrawRange(0, vertexCount);
  geometry.computeBoundingSphere();
}

/**
 * Releases GPU resources. Materials are shared across chunks and are
 * deliberately not touched here.
 *
 * Streaming creates and destroys these constantly, and three.js does not
 * free GPU buffers on garbage collection -- a geometry that is merely
 * dereferenced leaks its VBO for the lifetime of the page. This is the one
 * piece of manual memory management the port inherits from the C++
 * (~ChunkMesh).
 */
export function disposeChunkGeometry(geometry: BufferGeometry): void {
  geometry.dispose();
}
