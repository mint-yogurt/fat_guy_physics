import {
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  type Scene,
  type Texture,
} from "three/webgpu";

import type { Tree } from "@fgp/shared/sim/world";
import { Material, MATERIAL_COLORS } from "@fgp/shared/voxel/voxel";

import { sliceAtY } from "./sliceGeometry.ts";
import { horizontalRadius, type TreeAssets } from "./treeAssets.ts";

/**
 * Standing trees, as instances of the authored meshes.
 *
 * One Group per tree: the shared trunk geometry plus one mesh per foliage
 * cluster, scaled and yawed by the tree's own numbers. Geometry is shared
 * across every tree of a species until that tree is cut, at which point it
 * gets its own sliced copy -- so a forest of a thousand trees holds three
 * trunks' worth of vertices, and only the chopped ones cost more.
 *
 * Materials match the voxel trees they replace: the terrain's texture
 * modulated by the Wood and Leaf tints the mesher used to bake into vertex
 * colour. Lambert rather than the voxel material because the voxel shader
 * wants the mesher's vertex colours and voxel-unit UVs, and an authored
 * mesh has neither.
 */

/** A cut piece, ready to be handed to the rigid-body layer. */
export interface FellingPiece {
  /** Origin is the piece's centre, which is what a body's transform is. */
  readonly object: Object3D;
  readonly radius: number;
  readonly halfHeight: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Geometry owned outright by this piece, to dispose when it is culled. */
  readonly owned: readonly BufferGeometry[];
}

interface Instance {
  readonly group: Group;
  readonly trunk: Mesh;
  readonly foliage: Map<number, Mesh>;
  /** Set once a cut has given this tree its own trunk geometry. */
  ownedTrunk: BufferGeometry | undefined;
}

function tint(material: Material): number {
  const base = material * 3;
  const r = MATERIAL_COLORS[base] ?? 1;
  const g = MATERIAL_COLORS[base + 1] ?? 1;
  const b = MATERIAL_COLORS[base + 2] ?? 1;
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

export class TreeRenderer {
  private readonly instances = new Map<number, Instance>();
  private readonly trunkMaterial: MeshLambertMaterial;
  private readonly foliageMaterial: MeshLambertMaterial;

  /**
   * Where cut pieces go. Set by main once the physics layer has finished
   * loading its WASM; until then a cut simply removes the piece, which is
   * the behaviour the voxel trees had.
   */
  onFelled: ((piece: FellingPiece) => void) | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly assets: TreeAssets,
    map: Texture,
  ) {
    this.trunkMaterial = new MeshLambertMaterial({
      map,
      color: tint(Material.Wood),
      // The cut face is left open by the slicer, so the inside of the
      // trunk has to be drawn or a felled tree looks like it has a hole
      // punched through it.
      side: DoubleSide,
    });
    this.foliageMaterial = new MeshLambertMaterial({ map, color: tint(Material.Leaf) });
  }

  get count(): number {
    return this.instances.size;
  }

  onTreePlaced(tree: Tree): void {
    if (this.instances.has(tree.id)) return;
    const asset = this.assets.get(tree.species);
    if (asset === undefined) return;

    const group = new Group();
    group.position.set(tree.x, tree.y, tree.z);
    group.rotation.y = tree.yaw;
    group.scale.setScalar(tree.scale);

    const trunk = new Mesh(asset.trunk, this.trunkMaterial);
    group.add(trunk);

    const instance: Instance = { group, trunk, foliage: new Map(), ownedTrunk: undefined };

    for (let i = 0; i < asset.foliage.length; i++) {
      if ((tree.foliageMask & (1 << i)) === 0) continue;
      const geometry = asset.foliage[i];
      if (geometry === undefined) continue;
      const mesh = new Mesh(geometry, this.foliageMaterial);
      group.add(mesh);
      instance.foliage.set(i, mesh);
    }

    // A tree that streams back in already cut comes back as its stump.
    if (tree.severed) {
      this.applyStump(instance, sliceAtY(asset.trunk, tree.trunkTopMeters / tree.scale).below);
    }

    group.updateMatrix();
    this.scene.add(group);
    this.instances.set(tree.id, instance);
  }

  onTreeFoliageRemoved(tree: Tree, cluster: number): void {
    const instance = this.instances.get(tree.id);
    const mesh = instance?.foliage.get(cluster);
    if (instance === undefined || mesh === undefined) return;
    instance.foliage.delete(cluster);
    instance.group.remove(mesh);
  }

  /**
   * Cuts a standing tree's trunk and hands the piece above it on.
   *
   * The slice happens in the asset's own coordinates, so the cut height
   * comes back out of metres and into authored units first.
   */
  onTreeCut(
    tree: Tree,
    cutHeightMeters: number,
    pieceLengthMeters: number,
    carriedFoliage: number,
  ): void {
    const instance = this.instances.get(tree.id);
    const asset = this.assets.get(tree.species);
    if (instance === undefined || asset === undefined) return;

    const source = instance.ownedTrunk ?? asset.trunk;
    const sliced = sliceAtY(source, cutHeightMeters / tree.scale);
    const piece = this.buildPiece(tree, instance, sliced.above, cutHeightMeters, pieceLengthMeters, carriedFoliage);
    this.applyStump(instance, sliced.below);

    if (piece === undefined) return;
    if (this.onFelled === undefined) {
      for (const geometry of piece.owned) geometry.dispose();
      return;
    }
    this.onFelled(piece);
  }

  /** Replaces the standing trunk with what is left below the cut. */
  private applyStump(instance: Instance, below: BufferGeometry | undefined): void {
    const previous = instance.ownedTrunk;
    if (below === undefined) {
      instance.trunk.visible = false;
      instance.ownedTrunk = undefined;
    } else {
      below.computeBoundingSphere();
      instance.trunk.geometry = below;
      instance.trunk.visible = true;
      instance.ownedTrunk = below;
    }
    previous?.dispose();
  }

  private buildPiece(
    tree: Tree,
    instance: Instance,
    above: BufferGeometry | undefined,
    cutHeightMeters: number,
    pieceLengthMeters: number,
    carriedFoliage: number,
  ): FellingPiece | undefined {
    const owned: BufferGeometry[] = [];
    // Nested: the outer object is driven by the body's transform, so the
    // inner one carries the tree's own scale and yaw and the shift that
    // puts the piece's centre of length at the origin.
    const object = new Group();
    const inner = new Group();
    inner.rotation.y = tree.yaw;
    inner.scale.setScalar(tree.scale);
    inner.position.y = -(cutHeightMeters + pieceLengthMeters / 2);
    object.add(inner);

    let hasGeometry = false;
    if (above !== undefined) {
      above.computeBoundingSphere();
      owned.push(above);
      inner.add(new Mesh(above, this.trunkMaterial));
      hasGeometry = true;
    }

    const asset = this.assets.get(tree.species);
    for (const [cluster, mesh] of instance.foliage) {
      if ((carriedFoliage & (1 << cluster)) === 0) continue;
      instance.foliage.delete(cluster);
      instance.group.remove(mesh);
      const geometry = asset?.foliage[cluster];
      if (geometry === undefined) continue;
      inner.add(new Mesh(geometry, this.foliageMaterial));
      hasGeometry = true;
    }

    if (!hasGeometry) return undefined;

    const radius = Math.max(
      0.05,
      above === undefined ? tree.trunkRadiusMeters : horizontalRadius(above) * tree.scale,
    );
    return {
      object,
      radius,
      halfHeight: Math.max(0.05, pieceLengthMeters / 2 - radius),
      x: tree.x,
      y: tree.y + cutHeightMeters + pieceLengthMeters / 2,
      z: tree.z,
      owned,
    };
  }

  onTreeUnloaded(treeId: number): void {
    const instance = this.instances.get(treeId);
    if (instance === undefined) return;
    this.instances.delete(treeId);
    this.scene.remove(instance.group);
    instance.ownedTrunk?.dispose();
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      this.scene.remove(instance.group);
      instance.ownedTrunk?.dispose();
    }
    this.instances.clear();
    this.trunkMaterial.dispose();
    this.foliageMaterial.dispose();
  }
}
