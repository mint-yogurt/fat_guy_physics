import {
  Color,
  Group,
  MeshLambertNodeMaterial,
  type Material,
  type Mesh,
  type Object3D,
  type Scene,
  type Texture,
} from "three/webgpu";

import { CONTAINER_ITEMS, CONTAINER_KINDS, type ContainerKind } from "@fgp/shared/items/container";
import { ItemType } from "@fgp/shared/items/inventory";
import type { PlacementPlan } from "@fgp/shared/items/placement";
import { TRAMPOLINE_HEIGHT } from "@fgp/shared/items/trampoline";
import { PROP_METRICS } from "@fgp/shared/worldgen/props";

import { emptyContainerClone } from "./containerLook.ts";
import type { ItemAssets } from "./itemAssets.ts";
import type { PropTemplates } from "./propAssets.ts";

/**
 * The placement preview: a see-through copy of the held item, standing where
 * left mouse would put it. Green where it can go, red where it cannot (the
 * reason is the plan's, shared/items/placement.ts).
 *
 * Ghost builders are the only per-item part. Each returns the item's mesh in
 * the placement frame: origin on the ground at the middle of the footprint,
 * +Y up, turned by the plan's yaw. To preview a new placeable (a log, a sheet
 * of plywood, a 2x4), add its builder to {@link GHOSTS}.
 *
 * The ghost is the item's own meshes with their materials swapped for a
 * translucent tint. That swap is the transparency support: it keeps a source
 * material's map and alpha test, so a cut-out shape (the candy bucket's
 * handle) keeps its outline, and it is how anything else that needs drawing
 * see-through can be done.
 */

export interface GhostSources {
  readonly assets: ItemAssets;
  readonly props: PropTemplates;
}

type GhostBuilder = (sources: GhostSources) => Object3D | undefined;

const OK_TINT = new Color(0x2fe05a);
const BLOCKED_TINT = new Color(0xe83a2e);
const GHOST_OPACITY = 0.5;
/** How much of the tint the ghost gives off itself, so it reads in the dark as well. */
const GLOW = 0.65;

function containerGhost(kind: ContainerKind): GhostBuilder {
  return ({ props }) => {
    const mesh = emptyContainerClone(props, kind);
    if (mesh === undefined) return undefined;
    // The scale a placed one is given (main.ts `placeHeld`).
    const scaled = new Group();
    scaled.scale.setScalar(PROP_METRICS[kind].scale);
    scaled.add(mesh);
    const root = new Group();
    root.add(scaled);
    return root;
  };
}

const GHOSTS: Partial<Record<ItemType, GhostBuilder>> = {
  // The mat's mesh has its surface at the origin and its legs below it.
  [ItemType.Trampoline]: ({ assets }) => {
    const root = new Group();
    const mat = assets.trampoline.clone();
    mat.position.y = TRAMPOLINE_HEIGHT;
    root.add(mat);
    return root;
  },
};
for (const kind of CONTAINER_KINDS) GHOSTS[CONTAINER_ITEMS[kind]] = containerGhost(kind);

/** One mesh of a ghost, with the materials it wears when it can go and when it cannot. */
interface GhostMesh {
  readonly mesh: Mesh;
  readonly ok: Material | Material[];
  readonly blocked: Material | Material[];
}

interface Ghost {
  readonly root: Object3D;
  readonly meshes: readonly GhostMesh[];
  /** Which tint it wears now, if any yet. */
  valid: boolean | undefined;
}

/** The translucent stand-in for a source material: its outline (map, alpha test, sidedness), a flat tint. */
function ghostMaterial(source: Material, tint: Color): Material {
  const map = (source as { map?: Texture | null }).map ?? null;
  return new MeshLambertNodeMaterial({
    color: tint.clone().multiplyScalar(1 - GLOW),
    emissive: tint.clone().multiplyScalar(GLOW),
    map,
    alphaTest: source.alphaTest,
    side: source.side,
    transparent: true,
    opacity: GHOST_OPACITY,
    depthWrite: false,
  });
}

export class PlacementPreview {
  private readonly ghosts = new Map<ItemType, Ghost>();
  private shown: Ghost | undefined;
  /** Ghost materials by source material, so a mesh sharing one costs one. */
  private readonly okMaterials = new Map<Material, Material>();
  private readonly blockedMaterials = new Map<Material, Material>();

  constructor(
    private readonly scene: Scene,
    private readonly sources: GhostSources,
  ) {}

  /** Stands the ghost of `type` where `plan` says, tinted by whether it can go there. */
  show(type: ItemType, plan: PlacementPlan): void {
    const ghost = this.ghostOf(type);
    if (ghost !== this.shown) {
      this.hide();
      if (ghost === undefined) return;
      this.scene.add(ghost.root);
      this.shown = ghost;
    }
    if (ghost === undefined) return;
    ghost.root.position.set(plan.x, plan.y, plan.z);
    ghost.root.rotation.y = plan.yaw;
    if (ghost.valid !== plan.valid) {
      ghost.valid = plan.valid;
      for (const part of ghost.meshes) part.mesh.material = plan.valid ? part.ok : part.blocked;
    }
  }

  hide(): void {
    if (this.shown === undefined) return;
    this.scene.remove(this.shown.root);
    this.shown = undefined;
  }

  dispose(): void {
    this.hide();
    for (const material of this.okMaterials.values()) material.dispose();
    for (const material of this.blockedMaterials.values()) material.dispose();
    this.okMaterials.clear();
    this.blockedMaterials.clear();
    this.ghosts.clear();
  }

  private ghostOf(type: ItemType): Ghost | undefined {
    const known = this.ghosts.get(type);
    if (known !== undefined) return known;
    // No builder, or its meshes are not loaded: nothing to show (asked again next time).
    const root = GHOSTS[type]?.(this.sources);
    if (root === undefined) return undefined;
    const meshes: GhostMesh[] = [];
    root.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      meshes.push({
        mesh,
        ok: this.wear(mesh.material, this.okMaterials, OK_TINT),
        blocked: this.wear(mesh.material, this.blockedMaterials, BLOCKED_TINT),
      });
    });
    const ghost: Ghost = { root, meshes, valid: undefined };
    this.ghosts.set(type, ghost);
    return ghost;
  }

  private wear(
    source: Material | Material[],
    cache: Map<Material, Material>,
    tint: Color,
  ): Material | Material[] {
    const one = (material: Material): Material => {
      let ghost = cache.get(material);
      if (ghost === undefined) {
        ghost = ghostMaterial(material, tint);
        cache.set(material, ghost);
      }
      return ghost;
    };
    return Array.isArray(source) ? source.map(one) : one(source);
  }
}
