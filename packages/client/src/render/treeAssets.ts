import { Box3, BufferGeometry, Mesh, Vector3, type BufferAttribute } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { metricsFor, TreeSpecies } from "@fgp/shared/worldgen/trees";

import { faceOutward } from "./meshOrientation.ts";

/**
 * The authored tree meshes, loaded once and shared by every tree.
 *
 * Each file is flattened into geometry in *tree-base space*: node
 * transforms baked in, and the whole tree shifted so its lowest point sits
 * at y=0, which is where the sim puts the tree's root. That is the frame
 * TREE_METRICS is measured in, so a tree is drawn by scaling these
 * geometries by the tree's scale and nothing else.
 *
 * Everything is non-indexed, because a cut slices triangles (see
 * sliceGeometry.ts) and doing that to an index buffer means rebuilding it.
 * Trees are a few hundred vertices, so the duplication costs nothing worth
 * measuring.
 */

export interface SpeciesAsset {
  /** The trunk, including any branches the artist modelled as part of it. */
  readonly trunk: BufferGeometry;
  /** Foliage clusters, in the order TREE_METRICS lists them. */
  readonly foliage: readonly BufferGeometry[];
}

export type TreeAssets = ReadonlyMap<TreeSpecies, SpeciesAsset>;

const MESH_SPECIES: readonly TreeSpecies[] = [
  TreeSpecies.Conifer,
  TreeSpecies.Broadleaf,
  TreeSpecies.Dead,
];

/**
 * Bakes a node's world transform into its own copy of its geometry.
 *
 * Also rights the mesh if it was authored inside out, which some of the
 * foliage is -- a mirrored node transform would do the same thing, since
 * baking one in reverses the winding too.
 */
function flatten(mesh: Mesh): BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const geometry = (
    mesh.geometry.index === null ? mesh.geometry.clone() : mesh.geometry.toNonIndexed()
  ) as BufferGeometry;
  geometry.applyMatrix4(mesh.matrixWorld);
  if (geometry.getAttribute("normal") === undefined) geometry.computeVertexNormals();
  return faceOutward(geometry);
}

async function loadSpecies(species: TreeSpecies): Promise<SpeciesAsset | undefined> {
  const metrics = metricsFor(species);
  if (metrics === undefined) return undefined;

  const gltf = await new GLTFLoader().loadAsync(metrics.asset);
  const parts = new Map<string, BufferGeometry>();
  gltf.scene.traverse((object) => {
    if (object instanceof Mesh) parts.set(object.name, flatten(object));
  });

  // The files name their nodes, and the metrics table names them back, so
  // a renamed or missing node is a visible gap rather than a silent
  // mismatch between the mesh and what the sim thinks it can hit.
  const trunk = parts.get("trunk");
  if (trunk === undefined) {
    console.warn(`${metrics.asset}: no node named "trunk"`);
    return undefined;
  }
  const foliage: BufferGeometry[] = [];
  for (const cluster of metrics.foliage) {
    const geometry = parts.get(cluster.node);
    if (geometry === undefined) {
      console.warn(`${metrics.asset}: no node named "${cluster.node}"`);
      continue;
    }
    foliage.push(geometry);
  }

  // Tree-base space: the sim roots a tree at its lowest point, and the
  // files put their origin part-way up the trunk.
  const bounds = new Box3();
  for (const geometry of [trunk, ...foliage]) {
    geometry.computeBoundingBox();
    bounds.union(geometry.boundingBox ?? new Box3());
  }
  const lift = -bounds.min.y;
  for (const geometry of [trunk, ...foliage]) {
    geometry.translate(0, lift, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  // Trunks are drawn with [bark, stump] materials, which needs groups: all
  // bark until a cut adds a cap (see sliceGeometry.ts).
  trunk.clearGroups();
  trunk.addGroup(0, trunk.getAttribute("position").count, 0);

  return { trunk, foliage };
}

export async function loadTreeAssets(): Promise<TreeAssets> {
  const assets = new Map<TreeSpecies, SpeciesAsset>();
  const loaded = await Promise.all(MESH_SPECIES.map(async (species) => loadSpecies(species)));
  for (let i = 0; i < MESH_SPECIES.length; i++) {
    const species = MESH_SPECIES[i];
    const asset = loaded[i];
    if (species === undefined || asset === undefined) continue;
    assets.set(species, asset);
  }
  return assets;
}

/** Bounding radius in the XZ plane, for sizing a piece's collision shape. */
export function horizontalRadius(geometry: BufferGeometry): number {
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  if (position === undefined) return 0;
  const point = new Vector3();
  let radiusSq = 0;
  for (let i = 0; i < position.count; i++) {
    point.fromBufferAttribute(position, i);
    const d = point.x * point.x + point.z * point.z;
    if (d > radiusSq) radiusSq = d;
  }
  return Math.sqrt(radiusSq);
}
