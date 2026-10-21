import { Box3, Group, Mesh, MeshLambertNodeMaterial, NearestFilter, Vector3, type Material, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { ROCK_RADIUS } from "@fgp/shared/items/rock";
import { SNOW_UNIT_RADIUS } from "@fgp/shared/items/snowball";
import { TRAMPOLINE_HEIGHT } from "@fgp/shared/items/trampoline";
import { SKATE_BOARD_LENGTH } from "@fgp/shared/sim/skate";

import { litByBulbs } from "./bulbLights.ts";
import { createGooMaterial } from "./gooMaterial.ts";
import { faceOutward } from "./meshOrientation.ts";
import { buildCoil, readRopeParts, type RopeParts } from "./ropeView.ts";

/**
 * The item meshes, loaded once and cloned per use: on the ground, in the
 * hand, and in flight. Clones share geometry and materials, so a field of
 * a hundred sticks costs one stick's vertices.
 *
 * Every template is normalised into metres in a frame the rest of the code
 * can rely on without knowing the file:
 *
 *  - stick: the shaft runs along +Z, from the butt (the plain end, held in
 *    the hand) at z=0 to the fork (the business end) at z=STICK_LENGTH.
 *    That is how stick.glb is authored, at about 30 units long; its
 *    "attachment" node marks where the hand goes.
 *  - log: a cylinder along +Y, centred on the origin.
 *  - trampoline: upright, the mat's surface at the origin and the legs
 *    hanging TRAMPOLINE_HEIGHT below it, in game scale.
 *  - skateboard: long axis along +X, centred in X and Z, wheels resting on
 *    y=0, SKATE_BOARD_LENGTH long.
 *  - snowball: centred on the origin, SNOW_UNIT_RADIUS in radius: one unit of
 *    snow. A rolled snowball is this scaled up by how many units it is.
 *  - rock: centred on the origin, a squashed ball about ROCK_RADIUS in radius
 *    (its own shape: long one way, flat the other). A rock in the world is this
 *    scaled by its size, and turned as it rolls.
 *  - xmas lights: the string coiled up flat, centred on the origin, about
 *    25cm across. The string itself is drawn by ropeView.ts from `ropeParts`.
 *  - mountain lightning: the can standing on end, centred, 16cm tall.
 *  - eggnog: the carton standing on end, centred, 24cm tall; rolled as a ball of
 *    CARTON_RADIUS (items/rolledItems.ts), and laid on its side when it stops.
 *  - coal: a lump lying flat, centred, about 14cm across.
 *  - metal: a crushed block of cans, centred, about 16cm across.
 *  - candy: a chocolate bar, a rocket pop and a lollipop in a heap, centred, about 18cm across.
 *  - goo: the puddle of it lying flat, centred, about 32cm across: the item as it
 *    looks in a slot or on the ground. gooBall: the ball of it in the hand, 16cm.
 */

/**
 * Authored mean diameter of rock.glb, units: it is 0.39 x 0.42 x 0.31, already
 * game scale, so a rock drawn at this scale fits just outside its collision ball.
 */
const ROCK_AUTHORED_DIAMETER = 0.375;

/** Longest side of the coal lump and of the goo puddle as items, metres. */
const COAL_SIZE = 0.14;
const METAL_SIZE = 0.16;
const CANDY_SIZE = 0.18;
const GOO_SIZE = 0.32;
/** Diameter of the ball of goo in the hand, metres. */
const GOO_BALL_DIAMETER = 0.16;
/** Authored diameter of gooball.glb, units. */
const GOO_BALL_AUTHORED_DIAMETER = 0.44;

/** Authored width of snowball.glb, units: its three extents run from 0.39 to 0.46. */
const SNOWBALL_AUTHORED_DIAMETER = 0.42;

/** Authored length of skateboard.glb's deck along X, units. */
const SKATEBOARD_AUTHORED_LENGTH = 2.14;

/** Authored height of trampoline_small.glb's mat above the bottom of its feet, units. */
const TRAMPOLINE_AUTHORED_HEIGHT = 0.6;

/** Metres, butt to fork. The C++ build's voxel stick was 1.3m. */
export const STICK_LENGTH = 1.3;
/** Authored length of stick.glb along Z, units. */
const STICK_AUTHORED_LENGTH = 29.74;

/** How big a log reads on the ground, as a fraction of log.glb's 0.76m. */
const LOG_SCALE = 0.7;

export interface ItemAssets {
  /** Shaft along +Z, butt at the origin, in metres. */
  readonly stick: Object3D;
  /** Where the hand closes on the stick, metres from the butt along +Z. */
  readonly stickGrip: number;
  readonly log: Object3D;
  /** The log's length and radius in metres, as drawn. */
  readonly logLength: number;
  readonly logRadius: number;
  /** Mat surface at y=0, feet down to -TRAMPOLINE_HEIGHT. */
  readonly trampoline: Object3D;
  readonly skateboard: Object3D;
  /** The skateboard's height, wheels to deck top, in metres as drawn. */
  readonly skateboardHeight: number;
  /** A one-unit snowball, centred on the origin. */
  readonly snowball: Object3D;
  /** A standard rock, centred on the origin. */
  readonly rock: Object3D;
  /** Half its thickness as drawn, metres: how far its middle is above the ground when it lies on its flat side. */
  readonly rockRestHalfHeight: number;
  readonly mountainLightning: Object3D;
  readonly eggnog: Object3D;
  /** Half the carton's width as drawn, metres: how far its middle is above the ground when it lies on its side. */
  readonly eggnogRestHalfHeight: number;
  readonly coal: Object3D;
  readonly metal: Object3D;
  readonly candy: Object3D;
  /** Goo as an item: the flat puddle of it. */
  readonly goo: Object3D;
  /** Goo in the hand: a ball of it. */
  readonly gooBall: Object3D;
  /** The xmas lights wound into a coil: the item as it looks when it is not tied to anything. */
  readonly ropeCoil: Object3D;
  /** The pieces a tied string of xmas lights is assembled from. */
  readonly ropeParts: RopeParts;
}

/**
 * Wraps a file's scene so the wrapper's origin and scale are the normalised
 * frame, with the authored node transforms left alone underneath.
 */
function wrap(scene: Object3D, scale: number): Group {
  const outer = new Group();
  scene.scale.setScalar(scale);
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    faceOutward(object.geometry);
    object.castShadow = false;
  });
  outer.add(scene);
  return outer;
}

/**
 * Swaps a file's materials for ones lit like the props and glowing with the
 * bulbs, keeping each one's texture, filtered to match its pixel art.
 */
function pixelLit(scene: Object3D): void {
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const swap = (source: Material | undefined): Material => {
      const textured = source as (Material & { map?: { magFilter: number } | null }) | undefined;
      const map = textured?.map ?? null;
      if (map !== null) map.magFilter = NearestFilter;
      return litByBulbs(new MeshLambertNodeMaterial({ map: map as never }));
    };
    object.material = Array.isArray(object.material) ? object.material.map(swap) : swap(object.material);
  });
}

/** Re-centres a wrapped file on the origin, whatever its own origin is. */
function recentre(outer: Object3D, inner: Object3D): Box3 {
  outer.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(outer);
  inner.position.sub(bounds.getCenter(new Vector3()));
  outer.updateMatrixWorld(true);
  return new Box3().setFromObject(outer);
}

/** Scale that makes the longest side of the file's contents `size`. */
function fitScale(scene: Object3D, size: number): number {
  scene.updateMatrixWorld(true);
  const extent = new Box3().setFromObject(scene).getSize(new Vector3());
  return size / Math.max(extent.x, extent.y, extent.z, 1e-6);
}

export async function loadItemAssets(): Promise<ItemAssets> {
  const loader = new GLTFLoader();
  const [
    stickFile,
    logFile,
    trampolineFile,
    skateboardFile,
    snowballFile,
    lightsFile,
    rockFile,
    canFile,
    eggnogFile,
    coalFile,
    gooFile,
    gooBallFile,
    metalFile,
    candyFile,
  ] = await Promise.all([
    loader.loadAsync("/meshes/stick.glb"),
    loader.loadAsync("/meshes/log.glb"),
    loader.loadAsync("/meshes/trampoline_small.glb"),
    loader.loadAsync("/meshes/skateboard.glb"),
    loader.loadAsync("/meshes/snowball.glb"),
    loader.loadAsync("/meshes/xmaslights.glb"),
    loader.loadAsync("/meshes/rock.glb"),
    loader.loadAsync("/meshes/can_mowden_lightning.glb"),
    loader.loadAsync("/meshes/eggnog.glb"),
    loader.loadAsync("/meshes/coal.glb"),
    loader.loadAsync("/meshes/goo.glb"),
    loader.loadAsync("/meshes/gooball.glb"),
    loader.loadAsync("/meshes/metal.glb"),
    loader.loadAsync("/meshes/candy.glb"),
  ]);

  const stickScale = STICK_LENGTH / STICK_AUTHORED_LENGTH;
  const attachment = stickFile.scene.getObjectByName("attachment");
  const stick = wrap(stickFile.scene, stickScale);
  // A hand right on the butt would hide the end of the stick inside the
  // fist; a little way up it is how a stick is actually held.
  const stickGrip = Math.max(0.06, (attachment?.position.z ?? 0) * stickScale + 0.06);

  const log = wrap(logFile.scene, LOG_SCALE);
  const bounds = new Box3().setFromObject(log);
  const size = bounds.getSize(new Vector3());
  // Centred, whatever the file's origin is.
  const centre = bounds.getCenter(new Vector3());
  logFile.scene.position.sub(centre);

  // Authored Z-up: the mat is a disc in the XY plane and the feet hang
  // down -Z. Stood upright, and scaled so the mat sits at the height the
  // collision column ends at. Left untextured beyond whatever the file
  // itself carries (the frame has its own texture; the mat is plain).
  const trampoline = new Group();
  trampolineFile.scene.rotation.x = -Math.PI / 2;
  trampolineFile.scene.scale.setScalar(TRAMPOLINE_HEIGHT / TRAMPOLINE_AUTHORED_HEIGHT);
  trampoline.add(trampolineFile.scene);

  // Authored Z-up like the trampoline, with the long axis already on X.
  // Stood upright, then shifted so the wheels rest on y=0 under the middle.
  const skateboard = wrap(skateboardFile.scene, SKATE_BOARD_LENGTH / SKATEBOARD_AUTHORED_LENGTH);
  skateboardFile.scene.rotation.x = -Math.PI / 2;
  skateboard.updateMatrixWorld(true);
  const boardBounds = new Box3().setFromObject(skateboard);
  const boardCentre = boardBounds.getCenter(new Vector3());
  skateboardFile.scene.position.set(-boardCentre.x, -boardBounds.min.y, -boardCentre.z);

  const snowball = wrap(snowballFile.scene, (SNOW_UNIT_RADIUS * 2) / SNOWBALL_AUTHORED_DIAMETER);
  snowball.updateMatrixWorld(true);
  snowballFile.scene.position.sub(new Box3().setFromObject(snowball).getCenter(new Vector3()));

  // The stone texture is pixel art; the file's own material is swapped for one
  // that is lit like the props and glows with the bulbs, and filtered to match.
  pixelLit(rockFile.scene);
  const rock = wrap(rockFile.scene, (ROCK_RADIUS * 2.2) / ROCK_AUTHORED_DIAMETER);
  rock.updateMatrixWorld(true);
  const rockBounds = new Box3().setFromObject(rock);
  rockFile.scene.position.sub(rockBounds.getCenter(new Vector3()));
  // The file is long in Y, wide in X and thin in Z: it lies on its Z side, turned a quarter about X.
  const rockRestHalfHeight = (rockBounds.max.z - rockBounds.min.z) / 2;

  // Authored Z-up, like the trampoline: stood on end.
  pixelLit(canFile.scene);
  canFile.scene.rotation.x = -Math.PI / 2;
  const mountainLightning = wrap(canFile.scene, 1);
  recentre(mountainLightning, canFile.scene);

  pixelLit(eggnogFile.scene);
  eggnogFile.scene.rotation.x = -Math.PI / 2;
  const eggnog = wrap(eggnogFile.scene, 1);
  const eggnogBounds = recentre(eggnog, eggnogFile.scene);
  const eggnogRestHalfHeight = (eggnogBounds.max.x - eggnogBounds.min.x) / 2;

  // The lump is authored as a disc standing on its edge; laid flat.
  pixelLit(coalFile.scene);
  coalFile.scene.rotation.z = Math.PI / 2;
  const coal = wrap(coalFile.scene, fitScale(coalFile.scene, COAL_SIZE));
  recentre(coal, coalFile.scene);

  // A cube and a heap, both close to as tall as wide, so they need no turning.
  pixelLit(metalFile.scene);
  const metal = wrap(metalFile.scene, fitScale(metalFile.scene, METAL_SIZE));
  recentre(metal, metalFile.scene);
  pixelLit(candyFile.scene);
  const candy = wrap(candyFile.scene, fitScale(candyFile.scene, CANDY_SIZE));
  recentre(candy, candyFile.scene);

  // Slime has no texture of its own: it is the see-through goo material.
  const gooMaterial = createGooMaterial();
  const slime = (scene: Object3D): void => {
    scene.traverse((object) => {
      if (object instanceof Mesh) object.material = gooMaterial;
    });
  };
  slime(gooFile.scene);
  gooFile.scene.rotation.x = -Math.PI / 2;
  const goo = wrap(gooFile.scene, fitScale(gooFile.scene, GOO_SIZE));
  recentre(goo, gooFile.scene);

  slime(gooBallFile.scene);
  gooBallFile.scene.rotation.x = -Math.PI / 2;
  const gooBall = wrap(gooBallFile.scene, GOO_BALL_DIAMETER / GOO_BALL_AUTHORED_DIAMETER);
  recentre(gooBall, gooBallFile.scene);

  const ropeParts = readRopeParts(lightsFile.scene);
  const ropeCoil = buildCoil(ropeParts);

  return {
    trampoline,
    skateboard,
    snowball,
    rock,
    rockRestHalfHeight,
    mountainLightning,
    eggnog,
    eggnogRestHalfHeight,
    coal,
    metal,
    candy,
    goo,
    gooBall,
    ropeCoil,
    ropeParts,
    skateboardHeight: boardBounds.max.y - boardBounds.min.y,
    stick,
    stickGrip,
    log,
    logLength: size.y,
    logRadius: Math.max(size.x, size.z) / 2,
  };
}
