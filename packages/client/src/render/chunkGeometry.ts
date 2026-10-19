import { BufferGeometry, InterleavedBuffer, InterleavedBufferAttribute } from "three/webgpu";

import type { MeshData } from "@fgp/shared/voxel/greedyMesher";
import {
  FLOATS_PER_VERTEX,
  OFFSET_COLOR,
  OFFSET_NORMAL,
  OFFSET_POSITION,
  OFFSET_UV,
} from "@fgp/shared/voxel/vertexLayout";

/**
 * Turns the mesher's interleaved buffer into a three.js BufferGeometry.
 * Replaces src/voxel/ChunkMesh.{hpp,cpp}, which was raw VAO/VBO management.
 *
 * The mesher's output is a *view onto reusable scratch*, so the data is
 * copied here. That copy is the handoff point: at M3 the buffer arrives from
 * a worker as a transferable and already belongs to the main thread, so the
 * copy disappears and this takes ownership directly.
 */
export function createChunkGeometry(mesh: MeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  applyMeshData(geometry, mesh);
  return geometry;
}

/**
 * Replaces a geometry's contents in place.
 *
 * Reallocates rather than updating: an edited chunk's vertex count changes
 * (digging removes faces, exposes others), so the buffer genuinely has to be
 * resized. Growing into a pre-sized buffer and using `needsUpdate` is the
 * optimisation to reach for if remeshing ever shows up in a profile -- it is
 * not worth the bookkeeping until it does.
 */
export function applyMeshData(geometry: BufferGeometry, mesh: MeshData): void {
  const data = mesh.vertices.slice();
  const interleaved = new InterleavedBuffer(data, FLOATS_PER_VERTEX);

  geometry.setAttribute(
    "position",
    new InterleavedBufferAttribute(interleaved, 3, OFFSET_POSITION),
  );
  geometry.setAttribute("color", new InterleavedBufferAttribute(interleaved, 3, OFFSET_COLOR));
  geometry.setAttribute("uv", new InterleavedBufferAttribute(interleaved, 2, OFFSET_UV));
  geometry.setAttribute("normal", new InterleavedBufferAttribute(interleaved, 3, OFFSET_NORMAL));

  geometry.setDrawRange(0, mesh.vertexCount);
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
 * (~ChunkMesh), and M2 is where forgetting it starts to matter.
 */
export function disposeChunkGeometry(geometry: BufferGeometry): void {
  geometry.dispose();
}
