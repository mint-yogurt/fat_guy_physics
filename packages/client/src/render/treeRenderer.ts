import {
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertNodeMaterial,
  type Scene,
  type Texture,
} from "three/webgpu";

import type { Tree } from "@fgp/shared/sim/world";
import { Biome } from "@fgp/shared/voxel/biomeTint";
import { Material, MATERIAL_COLORS } from "@fgp/shared/voxel/voxel";
import { AUTUMN_FOLIAGE_COLOR } from "@fgp/shared/worldgen/generationSheet";
import { metricsFor, TreeSpecies } from "@fgp/shared/worldgen/trees";

import { sliceAtY } from "./sliceGeometry.ts";
import type { TreeAssets } from "./treeAssets.ts";
import { litByBulbs } from "./bulbLights.ts";
import type { TreeLightsView } from "./treeLights.ts";

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

/**
 * A length of tree off the ground: a felled top, or any part of one cut
 * again. Everything is in the species asset's own units (tree-base space,
 * see treeAssets.ts), so cutting it again is the same `sliceAtY` that cut
 * it off the stump.
 */
export interface PieceShape {
  /** The wood, owned outright by the piece; undefined for a bare tuft of foliage. */
  readonly trunk: BufferGeometry | undefined;
  /** Foliage riding on the piece: shared geometry, and the cluster's centre height. */
  readonly foliage: readonly {
    readonly geometry: BufferGeometry;
    readonly y: number;
  }[];
  /** Asset-space heights the piece spans. */
  readonly bottom: number;
  readonly top: number;
  readonly scale: number;
  readonly yaw: number;
  /** The standing trunk's radius in metres; a piece is never fatter than this. */
  readonly trunkRadiusMeters: number;
  /** Bark, then the cut face (geometry group CAP_GROUP). */
  readonly trunkMaterials: MeshLambertNodeMaterial[];
  readonly foliageMaterial: MeshLambertNodeMaterial;
}

/** A cut piece, ready to be handed to the rigid-body layer. */
export interface FellingPiece {
  readonly shape: PieceShape;
  /** World position of the piece's middle, which is where its body goes. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Instance {
  readonly group: Group;
  readonly trunk: Mesh;
  readonly foliage: Map<number, Mesh>;
  /** Green, or autumn for the living tree among the dead ones. */
  readonly foliageMaterial: MeshLambertNodeMaterial;
  /** Set once a cut has given this tree its own trunk geometry. */
  ownedTrunk: BufferGeometry | undefined;
}

function tint(material: Material): number {
  const base = material * 3;
  const r = MATERIAL_COLORS[base] ?? 1;
  const g = MATERIAL_COLORS[base + 1] ?? 1;
  const b = MATERIAL_COLORS[base + 2] ?? 1;
  return (
    (Math.round(r * 255) << 16) |
    (Math.round(g * 255) << 8) |
    Math.round(b * 255)
  );
}

export class TreeRenderer {
  private readonly instances = new Map<number, Instance>();
  private readonly trunkMaterial: MeshLambertNodeMaterial;
  /** The cut face of a stump or piece: treestump.png, untinted. */
  private readonly stumpMaterial: MeshLambertNodeMaterial;
  private readonly trunkMaterials: MeshLambertNodeMaterial[];
  private readonly foliageMaterial: MeshLambertNodeMaterial;
  private readonly autumnMaterial: MeshLambertNodeMaterial;

  /**
   * Where cut pieces go. Set by main once the physics layer has finished
   * loading its WASM; until then a cut simply removes the piece, which is
   * the behaviour the voxel trees had.
   */
  onFelled: ((piece: FellingPiece) => void) | undefined;
  /** Where Christmas trees' strings of lights are drawn, when there is one. */
  lights: TreeLightsView | undefined;

  constructor(
    private readonly scene: Scene,
    private readonly assets: TreeAssets,
    map: Texture,
    stumpMap: Texture,
  ) {
    this.trunkMaterial = litByBulbs(
      new MeshLambertNodeMaterial({
        map,
        color: tint(Material.Wood),
        // The slicer caps a cut, but the authored trunks are not all closed
        // meshes (branch ends, the base), so the inside stays drawn.
        side: DoubleSide,
      }),
    );
    this.stumpMaterial = litByBulbs(
      new MeshLambertNodeMaterial({ map: stumpMap }),
    );
    this.trunkMaterials = [this.trunkMaterial, this.stumpMaterial];
    this.foliageMaterial = litByBulbs(
      new MeshLambertNodeMaterial({ map, color: tint(Material.Leaf) }),
    );
    // The same leaves, recoloured: the texture is a placeholder, so the
    // autumn look is the tint alone.
    this.autumnMaterial = litByBulbs(
      new MeshLambertNodeMaterial({ map, color: AUTUMN_FOLIAGE_COLOR }),
    );
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

    const trunk = new Mesh(asset.trunk, this.trunkMaterials);
    group.add(trunk);

    const foliageMaterial =
      tree.biome === Biome.Halloween && tree.species === TreeSpecies.Broadleaf
        ? this.autumnMaterial
        : this.foliageMaterial;
    const instance: Instance = {
      group,
      trunk,
      foliage: new Map(),
      foliageMaterial,
      ownedTrunk: undefined,
    };

    for (let i = 0; i < asset.foliage.length; i++) {
      if ((tree.foliageMask & (1 << i)) === 0) continue;
      const geometry = asset.foliage[i];
      if (geometry === undefined) continue;
      const mesh = new Mesh(geometry, foliageMaterial);
      group.add(mesh);
      instance.foliage.set(i, mesh);
    }

    // A tree that streams back in already cut comes back as its stump.
    if (tree.severed) {
      this.applyStump(
        instance,
        sliceAtY(asset.trunk, tree.trunkTopMeters / tree.scale).below,
      );
    }

    group.updateMatrix();
    this.scene.add(group);
    this.instances.set(tree.id, instance);
    this.lights?.add(tree);
  }

  onTreeLightsRemoved(tree: Tree): void {
    this.lights?.remove(tree.id);
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
    const piece = this.buildPiece(
      tree,
      instance,
      sliced.above,
      cutHeightMeters,
      pieceLengthMeters,
      carriedFoliage,
    );
    this.applyStump(instance, sliced.below);

    if (piece === undefined) return;
    if (this.onFelled === undefined) {
      piece.shape.trunk?.dispose();
      return;
    }
    this.onFelled(piece);
  }

  /** Replaces the standing trunk with what is left below the cut. */
  private applyStump(
    instance: Instance,
    below: BufferGeometry | undefined,
  ): void {
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
    const asset = this.assets.get(tree.species);
    const metrics = metricsFor(tree.species);
    const foliage: { geometry: BufferGeometry; y: number }[] = [];
    for (const [cluster, mesh] of instance.foliage) {
      if ((carriedFoliage & (1 << cluster)) === 0) continue;
      instance.foliage.delete(cluster);
      instance.group.remove(mesh);
      const geometry = asset?.foliage[cluster];
      if (geometry === undefined) continue;
      foliage.push({ geometry, y: metrics?.foliage[cluster]?.y ?? 0 });
    }

    if (above === undefined && foliage.length === 0) return undefined;

    const bottom = cutHeightMeters / tree.scale;
    const top = (cutHeightMeters + pieceLengthMeters) / tree.scale;
    return {
      shape: {
        trunk: above,
        foliage,
        bottom,
        top,
        scale: tree.scale,
        yaw: tree.yaw,
        trunkRadiusMeters: tree.trunkRadiusMeters,
        trunkMaterials: this.trunkMaterials,
        foliageMaterial: instance.foliageMaterial,
      },
      x: tree.x,
      y: tree.y + cutHeightMeters + pieceLengthMeters / 2,
      z: tree.z,
    };
  }

  onTreeUnloaded(treeId: number): void {
    this.lights?.remove(treeId);
    const instance = this.instances.get(treeId);
    if (instance === undefined) return;
    this.instances.delete(treeId);
    this.scene.remove(instance.group);
    instance.ownedTrunk?.dispose();
  }

  clear(): void {
    this.lights?.clear();
    for (const instance of this.instances.values()) {
      this.scene.remove(instance.group);
      instance.ownedTrunk?.dispose();
    }
    this.instances.clear();
    this.trunkMaterial.dispose();
    this.stumpMaterial.dispose();
    this.foliageMaterial.dispose();
    this.autumnMaterial.dispose();
  }
}
