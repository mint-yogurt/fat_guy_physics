import {
  Box3,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertNodeMaterial,
  SRGBColorSpace,
  TextureLoader,
  type Material,
  type Object3D,
  type Texture,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import {
  PROP_KINDS,
  PROP_METRICS,
  type PropKind,
} from "@fgp/shared/worldgen/props";
import { litByBulbs } from "./bulbLights.ts";
import { nearestify } from "./n64Texture.ts";
import { hasTopFace, splitTopFace } from "./containerLook.ts";

/**
 * The authored prop meshes, loaded once and cloned per instance.
 *
 * Each template is stood upright and seated: a Z-up file is rotated onto
 * three's Y axis, then the whole thing is lifted so the prop's lowest point
 * rests on y=0 -- or, for a mesh authored to sit part-way into the ground
 * (the grave), left with its own origin on the ground. The renderer then
 * places an instance by position, yaw, lean and scale and nothing else.
 *
 * None of the files embed their textures, and their materials are named
 * rather than coloured, so what each material looks like is decided here, by
 * name, below. A material name nobody has an entry for draws plain white,
 * which is visible enough to notice.
 */

export type PropTemplates = ReadonlyMap<PropKind, Object3D>;

const TEXTURE_DIR = "/textures/";

interface Look {
  /** File in assets/textures, or none for a flat colour. */
  readonly map?: string;
  /** Multiplied into the map; the whole look when there is no map. */
  readonly color: number;
  /** Keep the texture the GLB itself carries, filtered as authored. */
  readonly embedded?: boolean;
  /** Cut out where the map is transparent (a handle's gap), rather than blended. */
  readonly cutout?: boolean;
}

/** By glTF material name. */
const LOOKS: Readonly<Record<string, Look>> = {
  snow: { color: 0xf3f7fb },
  carrot: { map: "carrot.png", color: 0xffffff },
  eye: { map: "eye.png", color: 0xffffff },
  tombstone1: { color: 0x8b8f94 },
  tombstone2: { color: 0x7b7f84 },
  tombstone2_engraved: { color: 0x4b4e52 },
  grave: { color: 0x3a2e25 },
  // Both present files misspell this ("wrappinpape"); which paper it is
  // comes from the file, below.
  wrappinpape: { color: 0xffffff },
  // The candy bucket: pail, candy corn filling, and a handle cut out of its alpha.
  bucket: { map: "bucket_candy.png", color: 0xffffff },
  candycorn: { map: "candycorn.png", color: 0xffffff },
  handle: { map: "handle.png", color: 0xffffff, cutout: true },
  // leafpile.glb embeds leaves1.jpg, a painted photo-style texture that
  // would only smear under the nearest filtering the pixel-art maps get.
  leafpile: { color: 0xffffff, embedded: true },
  // The gingerbread house: one texture over the whole mesh (UVs are in the file).
  gingerbreadhouse: { map: "gingerbread.png", color: 0xffffff },
};

/** By node name, overriding the material's: the grave's topsoil shares its box's material. */
const NODE_LOOKS: Readonly<Record<string, Look>> = {
  topsoil: { color: 0x4a3524 },
};

/** The wrapping paper each present file gets. */
const PAPER: Readonly<Partial<Record<PropKind, string>>> = {
  present_small: "wrappingpaper1.png",
  present_big: "wrappingpaper2.png",
};

const textureLoader = new TextureLoader();

async function loadMap(
  file: string,
  cache: Map<string, Promise<Texture>>,
): Promise<Texture> {
  let pending = cache.get(file);
  if (pending === undefined) {
    pending = textureLoader.loadAsync(TEXTURE_DIR + file).then((texture) => {
      // glTF's UV origin is the top-left, which is what flipY=false means.
      texture.flipY = false;
      texture.colorSpace = SRGBColorSpace;
      // Pixel art, N64 style: nearest, no mipmaps.
      return nearestify(texture);
    });
    cache.set(file, pending);
  }
  return pending;
}

async function loadTemplate(
  kind: PropKind,
  textures: Map<string, Promise<Texture>>,
  materials: Map<string, Material>,
): Promise<Object3D | undefined> {
  const metrics = PROP_METRICS[kind];
  const gltf = await new GLTFLoader().loadAsync(metrics.asset);

  const meshes: Mesh[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });

  for (const mesh of meshes) {
    const source = Array.isArray(mesh.material)
      ? mesh.material[0]
      : mesh.material;
    const materialName = source?.name ?? "";
    const look = NODE_LOOKS[mesh.name] ?? LOOKS[materialName];
    if (look === undefined)
      console.warn(`${metrics.asset}: no look for material "${materialName}"`);

    const file = materialName === "wrappinpape" ? PAPER[kind] : look?.map;
    const embedded =
      look?.embedded === true
        ? ((source as { map?: Texture | null }).map ?? null)
        : null;
    if (look?.embedded === true && embedded === null) {
      console.warn(
        `${metrics.asset}: material "${materialName}" has no embedded texture`,
      );
    }
    const key = `${embedded === null ? (file ?? "") : `embedded:${kind}`}|${(look?.color ?? 0xffffff).toString(16)}|${String(look?.cutout === true)}`;
    let material = materials.get(key);
    if (material === undefined) {
      material = litByBulbs(
        new MeshLambertNodeMaterial({
          color: new Color(look?.color ?? 0xffffff),
          map:
            (embedded === null ? null : nearestify(embedded)) ??
            (file === undefined ? null : await loadMap(file, textures)),
          // Some of these files come out of Blender inside out, and a doubled
          // face costs nothing on a mesh this small.
          side: DoubleSide,
          ...(look?.cutout === true ? { alphaTest: 0.5 } : {}),
        }),
      );
      materials.set(key, material);
    }
    mesh.material = material;
    // A present shows its top face separately, so an empty one can go black
    // (see containerLook.ts). Both slots start as the paper.
    if (hasTopFace(kind) && splitTopFace(mesh)) mesh.material = [material, material];
  }

  // Stand a Z-up file on its feet before measuring anything.
  const upright = new Group();
  if (metrics.up === "z") gltf.scene.rotation.x = -Math.PI / 2;
  upright.add(gltf.scene);
  upright.updateMatrixWorld(true);

  const bounds = new Box3().setFromObject(upright);
  if (metrics.centre === true) {
    gltf.scene.position.x = -(bounds.min.x + bounds.max.x) / 2;
    gltf.scene.position.z = -(bounds.min.z + bounds.max.z) / 2;
  }
  if (metrics.anchor === "bottom") {
    gltf.scene.position.y = -bounds.min.y;
  }
  return upright;
}

export async function loadPropAssets(): Promise<PropTemplates> {
  const textures = new Map<string, Promise<Texture>>();
  const materials = new Map<string, Material>();
  const templates = new Map<PropKind, Object3D>();
  // A rock is placed by the world but drawn as a rolling ball (snowballView).
  const kinds = PROP_KINDS.filter((kind) => PROP_METRICS[kind].dynamic !== true);
  const loaded = await Promise.all(
    kinds.map(async (kind) => loadTemplate(kind, textures, materials)),
  );
  kinds.forEach((kind, i) => {
    const template = loaded[i];
    if (template !== undefined) templates.set(kind, template);
  });
  return templates;
}
