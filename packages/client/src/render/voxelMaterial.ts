import { MeshBasicNodeMaterial, RepeatWrapping, type Texture } from "three/webgpu";
import { attribute, dot, float, max, normalGeometry, normalize, texture, uv, vec3 } from "three/tsl";

/**
 * The one custom material, ported from assets/shaders/basic.{vert,frag}.
 *
 * Written in TSL rather than as a raw GLSL ShaderMaterial because it has to
 * compile on both the WebGPU and WebGL2 backends -- WebGL2 is the
 * compatibility floor, and hand-maintaining two shader sources for one
 * material is how a port acquires a class of bug that only reproduces on
 * some people's machines.
 *
 * Deliberately a *Basic* node material, not Standard: lighting here is one
 * fixed directional sun plus a flat ambient floor, hand-rolled on top of the
 * per-face tint the mesher bakes into vertex colour. There is no shadow map
 * and no PBR; three's lighting system would fight this rather than help it.
 */

// From basic.frag. The sun direction is deliberately not normalised in the
// C++ source either -- it is normalised at use.
const SUN_DIRECTION = normalize(vec3(0.4, 1.0, 0.3));
const AMBIENT = float(0.55);
const SUN_COLOR = float(0.65);

/**
 * Forces sampling from a blurrier mip than the fragment's screen-space
 * footprint would pick, for the soft late-90s filtered look DESIGN.md asks
 * for. Revisited alongside the rest of the look at M12.
 */
const TEXTURE_LOD_BIAS = float(2.0);

export function createVoxelMaterial(map: Texture): MeshBasicNodeMaterial {
  // UVs span (0,0)-(w,h) in voxel units so a greedy-merged quad tiles the
  // texture once per voxel instead of stretching it. That requires repeat
  // wrapping; without it every merged quad clamps to the texture edge.
  map.wrapS = RepeatWrapping;
  map.wrapT = RepeatWrapping;

  const material = new MeshBasicNodeMaterial();

  const detail = texture(map, uv()).bias(TEXTURE_LOD_BIAS);

  // normalGeometry is the untransformed per-vertex normal. Chunk meshes are
  // placed with a translation only, so this equals the world normal; using
  // the geometry normal keeps this correct without pulling in the normal
  // matrix machinery a Standard material would.
  const ndotl = max(dot(normalize(normalGeometry), SUN_DIRECTION), float(0));
  const lighting = AMBIENT.add(SUN_COLOR.mul(ndotl));

  // Vertex colour carries materialColor * faceTint, baked by the mesher.
  // At M3 this splits into faceId + materialId attributes resolved here
  // instead, which is what makes per-object tinting free.
  material.colorNode = detail.rgb.mul(attribute("color", "vec3")).mul(lighting);

  // Alpha cutout rather than blending, so billboard sprites can share this
  // material and the opaque depth pass instead of needing a sorted
  // transparent pass. A no-op for opaque textures; first actually exercised
  // by bushes at M6.
  material.opacityNode = detail.a;
  material.alphaTest = 0.5;
  material.transparent = false;

  return material;
}
