/**
 * Mesh vertex layout.
 *
 * M1-M3 use the literal C++ layout -- {vec3 position, vec3 color, vec2 uv,
 * vec3 normal}, 11 floats / 44 bytes, interleaved, non-indexed -- so the port
 * can be diffed byte-for-byte against the reference build while the risky
 * parts (streaming, workers, the player controller) are going in.
 *
 * It changes once, at M3, to an 8-byte quantised layout with indexed quads.
 * That is also when the per-face tint stops being baked into the vertex
 * colour and becomes `faceTint[faceId] * materialColor[materialId] * uTint`
 * in the shader -- deferred to the same moment rather than done now, so the
 * layout changes once instead of twice. The shader-side tint is what makes
 * per-tree colour jitter (M6) and per-player part colours (M11) free.
 */

export const FLOATS_PER_VERTEX = 11;
export const VERTICES_PER_QUAD = 6;
export const FLOATS_PER_QUAD = FLOATS_PER_VERTEX * VERTICES_PER_QUAD;

export const OFFSET_POSITION = 0;
export const OFFSET_COLOR = 3;
export const OFFSET_UV = 6;
export const OFFSET_NORMAL = 8;

/**
 * Cheap static ambient occlusion: a fixed per-face brightness baked in at
 * mesh-build time from which way the face points. Top brightest as if lit
 * from the sky, bottom darkest, the two side pairs split slightly for
 * variety. Real shadowing is overkill for blocky terrain, and this keeps
 * terrain readable at distance at zero runtime cost.
 *
 * Indexed [axis * 2 + (backFace ? 1 : 0)]. Values must stay identical to
 * faceTint() in src/voxel/ChunkMesher.cpp and axisTint in TreeVoxels.cpp,
 * which duplicate each other today so tree geometry matches terrain shading.
 */
export const FACE_TINT = new Float32Array([
  0.65, 0.65, // X+ / X-
  1.0, 0.5, //  Y+ (top) / Y- (bottom)
  0.8, 0.8, //  Z+ / Z-
]);

export function faceTint(axis: number, backFace: boolean): number {
  return FACE_TINT[axis * 2 + (backFace ? 1 : 0)] as number;
}
