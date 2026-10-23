import {
  Color,
  MeshBasicNodeMaterial,
  RepeatWrapping,
  type Texture,
} from "three/webgpu";
import {
  attribute,
  dot,
  float,
  mix,
  normalGeometry,
  normalize,
  positionView,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";

import { GROUND } from "@fgp/shared/worldgen/generationSheet";

import { bulbGlow } from "./bulbLights.ts";
import { n64Sample } from "./n64Texture.ts";

/**
 * The ground's material: three big tiling textures (grass, dirt, snow) blended per vertex,
 * N64 style. Each texture is stretched over `GROUND.textureTileMeters` of ground, so its
 * pixels are chunky, and is read with the console's 3-point filter (see n64Texture.ts).
 *
 * Deliberately a *Basic* node material: the lighting is one baked sun term per vertex
 * (Gouraud, from the mesh) plus a flat ambient, both driven by the atmosphere, so there is no
 * scene lighting to fight. See the vertex layout in shared/worldgen/groundMesh.ts.
 *
 * The fade into the sky is done here with the atmosphere's own uniforms rather than by
 * `scene.fog`, so ground and props fade to exactly the same colour at the distances set there.
 */

/** Daylight defaults; the atmosphere overwrites them every frame. */
export const DEFAULT_AMBIENT = 0.55;
export const DEFAULT_SUN = 0.65;

/** The ground textures are 64x64 texels. */
const TEXTURE_TEXELS = 64;

export interface TerrainTextures {
  readonly grass: Texture;
  readonly dirt: Texture;
  readonly snow: Texture;
}

export interface TerrainMaterial {
  readonly material: MeshBasicNodeMaterial;
  /** Flat light floor; near zero is night. */
  readonly ambient: { value: number };
  /** Directional sun strength. */
  readonly sun: { value: number };
  /** What distant ground fades to. Kept equal to the sky colour. */
  readonly fogColor: { value: Color };
  /** Metres at which the fade starts and completes. */
  readonly fogNear: { value: number };
  readonly fogFar: { value: number };
}

export function createTerrainMaterial(textures: TerrainTextures): TerrainMaterial {
  for (const map of [textures.grass, textures.dirt, textures.snow]) {
    map.wrapS = RepeatWrapping;
    map.wrapT = RepeatWrapping;
  }

  const material = new MeshBasicNodeMaterial();

  const ambient = uniform(DEFAULT_AMBIENT);
  const sun = uniform(DEFAULT_SUN);
  const fogColor = uniform(new Color(0x87b8dc));
  const fogNear = uniform(8);
  const fogFar = uniform(40);

  // One uv for all three: ground position over the tile size, so a texture runs on unbroken
  // across the meeting of two tiles.
  const at = positionWorld.xz.div(GROUND.textureTileMeters);
  const grass = n64Sample(textures.grass, at, TEXTURE_TEXELS);
  const dirt = n64Sample(textures.dirt, at, TEXTURE_TEXELS);
  const snow = n64Sample(textures.snow, at, TEXTURE_TEXELS);

  const weights = attribute("groundWeights", "vec3");
  const albedo = grass.rgb.mul(weights.x).add(dirt.rgb.mul(weights.y)).add(snow.rgb.mul(weights.z));

  // Halloween ground is drained of colour.
  const spooky = attribute("groundSpooky", "float");
  const grey = dot(albedo, vec3(0.3, 0.59, 0.11));
  const drained = mix(albedo, vec3(grey), spooky.mul(GROUND.halloweenDesaturation));
  const tinted = drained.mul(attribute("groundTint", "vec3"));

  // Baked sun on the vertex, plus the ambient floor and the pools under any xmas lights.
  const normal = normalize(normalGeometry);
  const shade = attribute("groundShade", "float");
  const lighting = vec3(ambient.add(sun.mul(shade))).add(bulbGlow(positionWorld, normal));
  const lit = tinted.mul(lighting);

  const depth = positionView.z.negate();
  material.colorNode = mix(lit, fogColor, smoothstep(fogNear, fogFar, depth));
  material.opacityNode = float(1);
  material.transparent = false;
  // The fade above *is* the fog. Leaving this on would have three apply the scene's fog a
  // second time on top of it.
  material.fog = false;

  return { material, ambient, sun, fogColor, fogNear, fogFar };
}
