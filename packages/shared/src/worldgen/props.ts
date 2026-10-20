import type { PropKindName } from "./generationSheet.ts";

/**
 * Props: authored meshes that are scattered, not chopped.
 *
 * The same idea as trees.ts -- the sim knows a few numbers about each mesh,
 * the client scales the mesh to match -- but a prop has no foliage and no
 * cut state, so the numbers are fewer: a scale, which way is up in the
 * file, and a cylinder for aiming at it.
 *
 * Metrics were read off the GLB accessors, in authored units. The files are
 * several times game scale (a grave is 5.4 units long), so `scale` is the
 * dial: the one number to turn if a prop reads too big or small in game.
 */

export type PropKind = PropKindName;

export const PROP_KINDS: readonly PropKind[] = [
  "snowman_small",
  "snowman_big",
  "present_small",
  "present_big",
  "tombstone_1",
  "tombstone_2",
  "grave",
];

export function isPropKind(kind: string): kind is PropKind {
  return (PROP_KINDS as readonly string[]).includes(kind);
}

export interface PropMetrics {
  readonly asset: string;
  /**
   * Which file axis points up. Blender's own Z-up came through unconverted
   * on most of these exports (`z`); snowman_bigger.glb is the exception and
   * is Y-up (`y`). The client stands a Z-up file on its feet on load.
   */
  readonly up: "y" | "z";
  /** Authored units to metres at scale 1. */
  readonly scale: number;
  /** Per-instance size jitter, +/- this fraction. */
  readonly sizeJitter: number;
  /**
   * `bottom` rests the mesh's lowest point on the ground; `origin` puts the
   * file's own origin on the ground, for a mesh authored to sit part-way in
   * (the grave).
   */
  readonly anchor: "bottom" | "origin";
  /** Aiming cylinder, authored units; zero height means not aimable. */
  readonly radius: number;
  readonly height: number;
}

export const PROP_METRICS: Readonly<Record<PropKind, PropMetrics>> = {
  snowman_small: {
    asset: "/meshes/snowman_small.glb",
    up: "z",
    scale: 0.5,
    sizeJitter: 0.15,
    anchor: "bottom",
    radius: 0.552,
    height: 1.52,
  },
  snowman_big: {
    asset: "/meshes/snowman_bigger.glb",
    up: "y",
    scale: 0.5,
    sizeJitter: 0.15,
    anchor: "bottom",
    radius: 0.905,
    height: 3.18,
  },
  present_small: {
    asset: "/meshes/present_1.glb",
    up: "z",
    scale: 0.3,
    sizeJitter: 0.2,
    anchor: "bottom",
    radius: 1,
    height: 2,
  },
  present_big: {
    asset: "/meshes/present_2.glb",
    up: "z",
    scale: 0.3,
    sizeJitter: 0.2,
    anchor: "bottom",
    radius: 0.874,
    height: 2.49,
  },
  tombstone_1: {
    asset: "/meshes/tombstone_1.glb",
    up: "z",
    scale: 0.4,
    sizeJitter: 0.1,
    anchor: "bottom",
    radius: 0.613,
    height: 1.868,
  },
  tombstone_2: {
    asset: "/meshes/tombstone_2.glb",
    up: "z",
    scale: 0.4,
    sizeJitter: 0.1,
    anchor: "bottom",
    radius: 1,
    height: 2.7,
  },
  grave: {
    asset: "/meshes/grave.glb",
    up: "z",
    scale: 0.4,
    sizeJitter: 0.05,
    anchor: "origin",
    radius: 0,
    height: 0,
  },
};

/** The glTF node names inside grave.glb that the client treats specially. */
export const GRAVE_TOPSOIL_NODE = "topsoil";

/**
 * The grave box, in authored units, in the frame the client stands it up in:
 * origin on the ground at the box's centre, +X along its length, the x- face
 * at the head. Read off grave.glb: a unit cube scaled (2.679, 1.443, 1.443)
 * and centred 1.410 below the ground, so its rim is 0.033 above it.
 */
export const GRAVE_BOX = {
  halfLength: 2.679,
  halfWidth: 1.443,
  top: 0.033,
  bottom: -2.853,
  /** Height of the topsoil mound's crown above the ground. */
  moundTop: 0.558,
} as const;

/**
 * Where the tombstone stands, and how thick it is, in authored units: just
 * outside the x- face. Its engraved side is the file's +X, which is the side
 * toward the grave when it is planted unrotated.
 */
export const TOMBSTONE_HALF_THICKNESS: Readonly<Record<"tombstone_1" | "tombstone_2", number>> = {
  tombstone_1: 0.4,
  tombstone_2: 0.405,
};

/** Gap between the grave's head and the tombstone's back, authored units. */
export const TOMBSTONE_GAP = 0.25;
