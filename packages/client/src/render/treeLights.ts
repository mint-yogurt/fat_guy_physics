import { Vector3, type Scene } from "three/webgpu";

import type { Tree } from "@fgp/shared/sim/world";
import { hashFloat } from "@fgp/shared/rng/hash";
import { TREE_METRICS, TreeSpecies } from "@fgp/shared/worldgen/trees";

import { bulbLights } from "./bulbLights.ts";
import { RopeChain, type RopeParts } from "./ropeView.ts";

/**
 * Xmas lights strung on the Christmas conifers. How many a tree has is
 * decided in shared (`tree.lights`); this draws them: each string is laid
 * round the canopy as a short swag, in world space, from the same pieces a
 * tied rope is made of, and its bulbs light the snow round the tree like a
 * rope's do. A strike on the tree knocks them off (`remove`).
 */

/** Segments in one string: the same as a rope's. */
const SEGMENTS = 9;
/** Metres of light along the canopy, per string. */
const STRING_LENGTH = 2.6;
/** How far a string drops while it goes round, per metre along it. */
const SAG_PER_METER = 0.1;
/** How far into the needles a string sits, as a fraction of the canopy's radius there. */
const HUG = 0.82;
/** The conifer's trunk: a cone, this wide at the ground and coming to a point at the top. */
const TRUNK_BASE_RADIUS = 0.7;
const TRUNK_HEIGHT = 9.84;
/** What is left of a foliage tier's width at its tip, as a fraction of its base. */
const TIER_TIP = 0.18;
/** Authored heights between which the strings are hung. */
const LOW = 1.7;
const HIGH = 5.9;

/**
 * How wide the conifer is at an authored height: its trunk, or the foliage
 * round it. Each foliage tier is a skirt, widest at its bottom and tapering
 * to a tip, and they overlap, so the outline is the widest of them at that
 * height. (The metrics' radius is each tier's widest, at its bottom, not at
 * its centre.)
 */
export function canopyRadius(y: number): number {
  let radius = Math.max(0.1, TRUNK_BASE_RADIUS * (1 - y / TRUNK_HEIGHT));
  for (const tier of TREE_METRICS[TreeSpecies.Conifer]?.foliage ?? []) {
    const bottom = tier.y - tier.radiusY;
    const along = (y - bottom) / (2 * tier.radiusY);
    if (along < 0 || along > 1) continue;
    radius = Math.max(radius, tier.radiusXZ * (1 - (1 - TIER_TIP) * along));
  }
  return radius;
}

/**
 * Where string `index` of `count` lies on a tree: SEGMENTS + 1 points in
 * world space, winding round the canopy and downhill.
 */
export function treeStringPath(tree: Tree, index: number, count: number): Vector3[] {
  const band = (index + 0.5) / count;
  const jitter = hashFloat(tree.id, 0x11c9 + index, 0, 0) - 0.5;
  let y = (LOW + (HIGH - LOW) * band + jitter * 0.8) * tree.scale;
  let angle = hashFloat(tree.id, 0x11d0 + index, 0, 0) * Math.PI * 2;
  const step = STRING_LENGTH / SEGMENTS;
  const points: Vector3[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const radius = canopyRadius(y / tree.scale) * tree.scale * HUG;
    points.push(
      new Vector3(
        tree.x + Math.cos(angle) * radius,
        tree.y + y,
        tree.z + Math.sin(angle) * radius,
      ),
    );
    angle += step / Math.max(0.3, radius);
    y -= step * SAG_PER_METER;
  }
  return points;
}

interface StringOnTree {
  readonly chain: RopeChain;
  /** x, y, z, r, g, b for each lit bulb. */
  readonly lights: number[];
}

export class TreeLightsView {
  private readonly strings = new Map<number, StringOnTree[]>();

  constructor(
    private readonly scene: Scene,
    private readonly parts: RopeParts,
  ) {}

  /** Hangs a tree's strings, if it has any and does not already. */
  add(tree: Tree): void {
    if (tree.lights <= 0 || this.strings.has(tree.id)) return;
    const made: StringOnTree[] = [];
    for (let i = 0; i < tree.lights; i++) {
      const chain = new RopeChain(this.parts, SEGMENTS);
      chain.along(treeStringPath(tree, i, tree.lights), (mid, out) => {
        out.set(mid.x - tree.x, -0.5, mid.z - tree.z).normalize();
      });
      const lights: number[] = [];
      chain.collectLights(lights);
      this.scene.add(chain.root);
      made.push({ chain, lights });
    }
    this.strings.set(tree.id, made);
  }

  remove(treeId: number): void {
    const made = this.strings.get(treeId);
    if (made === undefined) return;
    for (const { chain } of made) this.scene.remove(chain.root);
    this.strings.delete(treeId);
  }

  /** Offers every hung bulb to the glow pool; between its `begin` and `commit`. */
  offerLights(): void {
    for (const made of this.strings.values()) {
      for (const { lights } of made) {
        for (let i = 0; i < lights.length; i += 6) {
          bulbLights.offer(
            lights[i] ?? 0,
            lights[i + 1] ?? 0,
            lights[i + 2] ?? 0,
            lights[i + 3] ?? 0,
            lights[i + 4] ?? 0,
            lights[i + 5] ?? 0,
          );
        }
      }
    }
  }

  clear(): void {
    for (const made of this.strings.values()) {
      for (const { chain } of made) this.scene.remove(chain.root);
    }
    this.strings.clear();
  }
}
