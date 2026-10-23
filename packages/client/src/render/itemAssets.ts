import {
  Box3,
  Color,
  DoubleSide,
  Group,
  Mesh,
  MeshLambertNodeMaterial,
  Object3D,
  Vector3,
  type Material,
  type Texture,
} from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { ROCK_RADIUS } from "@fgp/shared/items/rock";
import { SNOW_UNIT_RADIUS } from "@fgp/shared/items/snowball";
import { TRAMPOLINE_HEIGHT } from "@fgp/shared/items/trampoline";
import { SKATE_BOARD_LENGTH } from "@fgp/shared/sim/skate";

import { litByBulbs } from "./bulbLights.ts";
import { nearestify } from "./n64Texture.ts";
import { createGooMaterial } from "./gooMaterial.ts";
import { faceOutward } from "./meshOrientation.ts";
import { readPaperParts, type PaperParts } from "./paperFlap.ts";
import { bulbGlassMaterial, buildCoil, readRopeParts, type RopeParts } from "./ropeView.ts";

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
 *  - toobifer (a 2x4), plywood (a sheet), wheel, ladder: as authored, centred, with their
 *    longest side fitted to TOOBIFER_SIZE etc. (a 1m beam along Z, a 2.4m sheet lying
 *    flat in XZ, a 60cm wheel on its X axis, a 3m ladder along Z). They are drawn far
 *    smaller than they are, like the log, so they read as items.
 *  - spring: standing on end, centred, 20cm tall.
 *  - spring shoes: one shoe, as authored (no resizing). `springShoe` is the one on a foot: the
 *    top face of its sole at the origin, facing up, with the spring hanging below it and the
 *    toe along +X. `springShoeItem` is a pair-sized look for the slot and the ground: the
 *    same shoe fitted to SPRING_SHOES_SIZE, centred.
 *  - fishing rod: `fishingRod` is the item (slot, ground): lying along +Z, centred, ROD_ITEM_SIZE
 *    long. `fishingRodHeld` is the one in the hand, HELD_ROD_LENGTH long: the Blade frame, the
 *    handle's "hand_attachment_point" at the origin and the rod running out along +Z, with a
 *    child named ROD_TIP_NAME where the line leaves it ("line_attachment_point").
 *  - leaves: a small bunch of different leaves lying flat in XY, facing +Z, centred, LEAVES_SIZE across.
 *  - toilet paper: `toiletPaper` is the item (slot, ground): the roll with its flap as modelled, centred.
 *    `toiletPaperRoll` is the roll alone for a rolled one: standing on end (its axis on Y), centred. The
 *    parts themselves are in `paperParts` (render/paperFlap.ts), which also builds the one in the hand.
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
/** Longest side of the crafting materials as items, metres. */
const TOOBIFER_SIZE = 0.5;
const PLYWOOD_SIZE = 0.7;
const WHEEL_SIZE = 0.3;
const LADDER_SIZE = 0.9;
const SPRING_SIZE = 0.2;
const SPRING_SHOES_SIZE = 0.3;
/** The fishing rod: its longest side as an item, and its whole length in the hand, metres. */
const ROD_ITEM_SIZE = 0.9;
const HELD_ROD_LENGTH = 2.2;
/** The child of the held rod that sits where the fishing line leaves it. */
export const ROD_TIP_NAME = "rod_tip";
/** A bunch of leaves, longest side, metres. */
const LEAVES_SIZE = 0.4;
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
  readonly toobifer: Object3D;
  readonly plywood: Object3D;
  readonly wheel: Object3D;
  readonly ladder: Object3D;
  readonly spring: Object3D;
  /** A spring shoe at its authored size, its sole's top face at the origin (see above): the one on the foot. */
  readonly springShoe: Object3D;
  /** The shoe fitted to a slot or the ground, centred. */
  readonly springShoeItem: Object3D;
  /** The fishing rod as an item: lying along +Z, centred. */
  readonly fishingRod: Object3D;
  /** The fishing rod in a hand (see the notes above); the line leaves from its ROD_TIP_NAME child. */
  readonly fishingRodHeld: Object3D;
  /** Goo as an item: the flat puddle of it. */
  readonly goo: Object3D;
  /** Goo in the hand: a ball of it. */
  readonly gooBall: Object3D;
  /** The xmas lights wound into a coil: the item as it looks when it is not tied to anything. */
  readonly ropeCoil: Object3D;
  /** The pieces a tied string of xmas lights is assembled from. */
  readonly ropeParts: RopeParts;
  /** A bunch of leaves. */
  readonly leaves: Object3D;
  /** The roll of toilet paper with its flap as modelled: the item. */
  readonly toiletPaper: Object3D;
  /** The roll alone, standing on end: what rolls along. */
  readonly toiletPaperRoll: Object3D;
  /** Half the roll's length along its axis as drawn, metres: how far its middle is above the ground when it stands on end. */
  readonly toiletPaperRestHalfHeight: number;
  /** The roll, flap and hand mark as read from the file; the flap in a hand and the trails are made from these. */
  readonly paperParts: PaperParts;
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
      const textured = source as (Material & { map?: Texture | null; color?: Color }) | undefined;
      const map = textured?.map ?? null;
      if (map !== null) nearestify(map);
      // A material with no texture keeps its own colour (the bulbs on the spring shoes).
      const colour = map === null ? textured?.color : undefined;
      return litByBulbs(new MeshLambertNodeMaterial(colour === undefined ? { map: map as never } : { color: colour }));
    };
    object.material = Array.isArray(object.material) ? object.material.map(swap) : swap(object.material);
  });
}

/**
 * Where the fishing line leaves the rod, in the file's own frame. The file marks it with an
 * empty named line_attachment_point; if that is still sitting at the file's origin (the
 * handle's butt, where an unmoved empty ends up) the top of the rod is used instead.
 */
function rodLineAttachment(scene: Object3D): Vector3 {
  const marked = scene.getObjectByName("line_attachment_point");
  if (marked !== undefined && marked.position.lengthSq() > 1e-6) return marked.position.clone();
  console.warn("fishinrod.glb: line_attachment_point is at the origin; using the top of the rod instead");
  const rod = scene.getObjectByName("rod");
  scene.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(rod ?? scene);
  const top = bounds.getCenter(new Vector3());
  top.y = bounds.max.y;
  return top;
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

/**
 * Where the top face of the shoe's sole is, in the stood-up scene's own frame:
 * the plank ("2x4") is the sole, so this is the middle of its top, found from its
 * bounds rather than assumed.
 */
function shoeSoleTop(scene: Object3D): Vector3 {
  scene.updateMatrixWorld(true);
  const plank = scene.getObjectByName("2x4");
  const bounds = new Box3().setFromObject(plank ?? scene);
  const top = bounds.getCenter(new Vector3());
  top.y = bounds.max.y;
  return top;
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
    toobiferFile,
    plywoodFile,
    wheelFile,
    ladderFile,
    springFile,
    springShoesFile,
    rodFile,
    leavesFile,
    paperFile,
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
    loader.loadAsync("/meshes/toobifer.glb"),
    loader.loadAsync("/meshes/plywood.glb"),
    loader.loadAsync("/meshes/wheel.glb"),
    loader.loadAsync("/meshes/ladder.glb"),
    loader.loadAsync("/meshes/spring.glb"),
    loader.loadAsync("/meshes/spring shoes.glb"),
    loader.loadAsync("/meshes/fishinrod.glb"),
    loader.loadAsync("/meshes/leaves.glb"),
    // The toilet paper: roll, flap, hand mark.
    loader.loadAsync("/meshes/tp.glb"),
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

  // Wood pieces, left in their authored pose and fitted to size.
  const wood = (file: { scene: Object3D }, size: number): Object3D => {
    pixelLit(file.scene);
    const outer = wrap(file.scene, fitScale(file.scene, size));
    recentre(outer, file.scene);
    return outer;
  };
  const toobifer = wood(toobiferFile, TOOBIFER_SIZE);
  const plywood = wood(plywoodFile, PLYWOOD_SIZE);
  const wheel = wood(wheelFile, WHEEL_SIZE);
  const ladder = wood(ladderFile, LADDER_SIZE);

  // The spring is authored Z-up, like the can: stood on end.
  pixelLit(springFile.scene);
  springFile.scene.rotation.x = -Math.PI / 2;
  const spring = wrap(springFile.scene, fitScale(springFile.scene, SPRING_SIZE));
  recentre(spring, springFile.scene);

  // The shoe is authored Z-up with the sole's top face at the top of the wooden
  // plank, the spring hanging below it. On a foot it is stood up and moved so that
  // face is at the origin; as an item it is the same shoe, fitted and centred.
  pixelLit(springShoesFile.scene);
  const shoeItemScene = springShoesFile.scene.clone();
  springShoesFile.scene.rotation.x = -Math.PI / 2;
  const springShoe = wrap(springShoesFile.scene, 1);
  springShoe.updateMatrixWorld(true);
  const soleTop = shoeSoleTop(springShoesFile.scene);
  springShoesFile.scene.position.set(-soleTop.x, -soleTop.y, -soleTop.z);
  shoeItemScene.rotation.x = -Math.PI / 2;
  const springShoeItem = wrap(shoeItemScene, fitScale(shoeItemScene, SPRING_SHOES_SIZE));
  recentre(springShoeItem, shoeItemScene);

  // The rod has a string of lights built into it. Its bulbs are lit glass like the bulbs of the
  // lights themselves; everything else is lit like the props.
  const rodGlass = new Map<Mesh, Material>();
  rodFile.scene.traverse((object) => {
    if (!(object instanceof Mesh) || Array.isArray(object.material)) return;
    const glass = bulbGlassMaterial(object.material.name);
    if (glass !== undefined) rodGlass.set(object, glass);
  });
  pixelLit(rodFile.scene);
  for (const [mesh, glass] of rodGlass) mesh.material = glass;
  rodFile.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    faceOutward(object.geometry);
    object.castShadow = false;
  });
  const rodHand = rodFile.scene.getObjectByName("hand_attachment_point")?.position.clone() ?? new Vector3();
  const rodTip = rodLineAttachment(rodFile.scene);
  rodFile.scene.updateMatrixWorld(true);
  const rodAuthored = new Box3().setFromObject(rodFile.scene).getSize(new Vector3()).y;

  // In the hand: authored along +Y, turned onto +Z and scaled, with the handle's mark at the origin.
  const rodHeldScene = rodFile.scene.clone();
  const heldScale = HELD_ROD_LENGTH / Math.max(rodAuthored, 1e-6);
  rodHeldScene.scale.setScalar(heldScale);
  rodHeldScene.rotation.x = Math.PI / 2;
  const handHeld = rodHand.clone().multiplyScalar(heldScale).applyEuler(rodHeldScene.rotation);
  rodHeldScene.position.copy(handHeld).negate();
  const tipMark = new Object3D();
  tipMark.name = ROD_TIP_NAME;
  tipMark.position.copy(rodTip).multiplyScalar(heldScale).applyEuler(rodHeldScene.rotation).sub(handHeld);
  const fishingRodHeld = new Group();
  fishingRodHeld.add(rodHeldScene, tipMark);

  // As an item: lying along +Z like the ladder, fitted to size and centred.
  const rodItemScene = rodFile.scene.clone();
  rodItemScene.rotation.x = Math.PI / 2;
  rodItemScene.scale.setScalar(fitScale(rodItemScene, ROD_ITEM_SIZE));
  const fishingRod = new Group();
  fishingRod.add(rodItemScene);
  recentre(fishingRod, rodItemScene);

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

  // Flat leaves with a cut-out outline, seen from both sides.
  pixelLit(leavesFile.scene);
  leavesFile.scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material.side = DoubleSide;
      material.alphaTest = 0.5;
    }
  });
  const leaves = wrap(leavesFile.scene, fitScale(leavesFile.scene, LEAVES_SIZE));
  recentre(leaves, leavesFile.scene);

  const paperParts = readPaperParts(paperFile.scene);
  if (paperParts === undefined) throw new Error('tp.glb: no node called "duct tape" (the roll)');
  if (paperParts.flap === undefined) throw new Error('tp.glb: no node called "flap" (nothing to flap or trail)');
  const paperItem = new Group();
  paperItem.add(new Mesh(paperParts.roll, paperParts.material));
  if (paperParts.flap !== undefined) paperItem.add(new Mesh(paperParts.flap, paperParts.material));
  const toiletPaper = new Group();
  toiletPaper.add(paperItem);
  recentre(toiletPaper, paperItem);
  // Turned so the roll's axis is up and centred on the roll alone: what rolls, and what stands.
  const standing = new Group();
  standing.add(new Mesh(paperParts.roll, paperParts.material));
  standing.quaternion.setFromUnitVectors(paperParts.rollAxis, new Vector3(0, 1, 0));
  standing.position.copy(paperParts.rollCentre).applyQuaternion(standing.quaternion).negate();
  const toiletPaperRoll = new Group();
  toiletPaperRoll.add(standing);

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
    toobifer,
    plywood,
    wheel,
    ladder,
    spring,
    springShoe,
    springShoeItem,
    fishingRod,
    fishingRodHeld,
    goo,
    gooBall,
    ropeCoil,
    ropeParts,
    leaves,
    toiletPaper,
    toiletPaperRoll,
    toiletPaperRestHalfHeight: paperParts.rollHalfLength,
    paperParts,
    skateboardHeight: boardBounds.max.y - boardBounds.min.y,
    stick,
    stickGrip,
    log,
    logLength: size.y,
    logRadius: Math.max(size.x, size.z) / 2,
  };
}
