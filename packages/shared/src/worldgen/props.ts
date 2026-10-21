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
  "bucket_candy",
  "tombstone_1",
  "tombstone_2",
  "grave",
  "leafpile",
  "snowbank",
  "rock",
  "gbreadhouse_1",
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
  /**
   * Slide the mesh sideways so the middle of its footprint is on the origin,
   * for a file whose origin is off to one side (the leaf pile).
   */
  readonly centre?: boolean;
  /**
   * Aiming cylinder, authored units; zero height means not aimable. The radius
   * also sizes the footprint checked for level ground, so a flat prop sets one
   * with a height of zero.
   */
  readonly radius: number;
  readonly height: number;
  /** Left-mouse scooping with empty hands works on it, as well as a chup. */
  readonly scoopable?: boolean;
  /**
   * Gets smaller as its resources are used up, and is gone when they are
   * (a snowbank): see `World.harvestPropYield`.
   */
  readonly depletes?: boolean;
  /**
   * Placed by the world but not a prop: it becomes a physical body that is
   * moved, roped and picked up (a rock). The world hands it to the game with
   * `onRockPlaced` instead of keeping it, and the renderer does not draw it.
   */
  readonly dynamic?: boolean;
  /**
   * Hit it enough, from anywhere, and it explodes: the mesh comes apart into
   * its triangles, which fly off and vanish, and the prop is gone for good
   * (a gingerbread house). Whatever was inside (`Prop.loot`) comes out. Until
   * then it is solid, as a box `halfX` x `halfZ` out from its middle and
   * `height` tall (authored units).
   */
  readonly breakable?: {
    readonly hits: number;
    readonly halfX: number;
    readonly halfZ: number;
    readonly height: number;
  };
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
  // Read off bucket_candy.glb: a Z-up pail 2.27 wide and 1.03 high, its handle
  // arching on to 2.09. The "filling" node (candy corn) is hidden when it is
  // empty. Nearly a metre across at this scale, a big trick-or-treat pail.
  bucket_candy: {
    asset: "/meshes/bucket_candy.glb",
    up: "z",
    scale: 0.4,
    sizeJitter: 0.1,
    anchor: "bottom",
    radius: 1.13,
    height: 2.09,
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
  // Read off leafpile.glb: a Z-up mound 4.0 x 3.7 wide and 0.78 high, with
  // its origin 0.73 left of centre. Left at authored size on purpose; it is
  // not aimable and not solid.
  leafpile: {
    asset: "/meshes/leafpile.glb",
    up: "z",
    scale: 1,
    sizeJitter: 0.1,
    anchor: "bottom",
    centre: true,
    radius: 2,
    height: 0,
  },
  // Read off snowbank.glb: a Z-up drift 6.8 x 6.9 wide and 1.63 high, its
  // origin well off to one side. Half scale makes it a 3.4m mound. Unlike the
  // leaf pile it is aimable, with a cylinder snug inside its slopes, because
  // hitting it is the point; the jitter is the 20% asked for.
  snowbank: {
    asset: "/meshes/snowbank.glb",
    up: "z",
    scale: 0.5,
    sizeJitter: 0.2,
    anchor: "bottom",
    centre: true,
    radius: 2.6,
    height: 1.2,
    scoopable: true,
    depletes: true,
  },
  // rock.glb is already game scale: about 40cm across (a Y-up squashed
  // sphere). Size varies a lot rock to rock, and weight with the cube of it.
  rock: {
    asset: "/meshes/rock.glb",
    up: "y",
    scale: 1,
    sizeJitter: 0.3,
    anchor: "bottom",
    radius: 0.2,
    height: 0,
    dynamic: true,
  },
  // Read off gbreadhouse_1.glb: a Z-up house 3.0 x 3.0 on the floor with walls
  // 2.28 high, a gabled roof to 3.92 and a chimney to 5.03. At 0.8 that is a
  // 2.4 m square cabin with walls about as tall as the player. Solid as a box
  // until it is hit to pieces (12 chups); the cylinder (round the corners) is
  // what is aimed at and what sizes the level-ground check.
  gbreadhouse_1: {
    asset: "/meshes/gbreadhouse_1.glb",
    up: "z",
    scale: 0.8,
    sizeJitter: 0.1,
    anchor: "bottom",
    radius: 2.2,
    height: 5.03,
    breakable: { hits: 12, halfX: 1.5, halfZ: 1.5, height: 2.28 },
  },
};

/**
 * A prop that is stacked in parts, each of which takes its own damage and
 * comes off on its own (a snowman: a ball, a ball, a head). Parts are listed
 * from the ground up. Heights are authored units above the mesh's lowest
 * point, which is where the prop stands on the ground.
 *
 * A part that breaks takes everything above it with it, since nothing holds
 * those up any more; the bottom part going is the whole prop going.
 */
export interface PropSection {
  /** glTF node names that make up the part (hidden when it is gone). */
  readonly nodes: readonly string[];
  /** Where the part's sphere is centred and how big it is: its collision and where it explodes from. */
  readonly centre: number;
  readonly radius: number;
  /** Hits below this height land on this part (the last part takes everything above the one before). */
  readonly top: number;
  /** Damage it takes before it comes off. */
  readonly hits: number;
  /** Snowballs of snow it leaves when it explodes. */
  readonly snow: number;
  /** Breaking it releases the object's `drops` in the generation sheet (the eyes are coal). */
  readonly releasesDrops?: boolean;
}

/**
 * Read off the GLBs (each ball is a unit sphere scaled to its radius, so the
 * numbers are the node scales and heights). Hit points are the dial: a chup is 1.
 */
export const PROP_SECTIONS: Readonly<Partial<Record<PropKind, readonly PropSection[]>>> = {
  snowman_small: [
    { nodes: ["body_lower"], centre: 0.552, radius: 0.552, top: 1.03, hits: 6, snow: 3 },
    {
      nodes: ["head", "eye_L", "eye_R", "nose_carrot"],
      centre: 1.239,
      radius: 0.283,
      top: Infinity,
      hits: 4,
      snow: 2,
      releasesDrops: true,
    },
  ],
  snowman_big: [
    { nodes: ["body_lower"], centre: 0.904, radius: 0.904, top: 1.543, hits: 8, snow: 4 },
    { nodes: ["body_mid"], centre: 1.945, radius: 0.667, top: 2.489, hits: 6, snow: 3 },
    {
      nodes: ["head", "eye_L", "eye_R", "Cone"],
      centre: 2.771,
      radius: 0.406,
      top: Infinity,
      hits: 4,
      snow: 2,
      releasesDrops: true,
    },
  ],
};

/** The glTF node names inside grave.glb that the client treats specially. */
export const GRAVE_TOPSOIL_NODE = "topsoil";

/** The node inside bucket_candy.glb that is hidden when the bucket is empty. */
export const BUCKET_FILLING_NODE = "filling";

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
