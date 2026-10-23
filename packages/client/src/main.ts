import "./ui/ui.css";

// Everything comes from "three/webgpu", never from "three". The webgpu entry
// bundles its own copy of three's core, so mixing the two imports loads the
// library twice -- three warns about it at runtime, and it doubles the
// bundle while making `instanceof` checks across the boundary fail.
// three/webgpu re-exports all of Three.Core, so there is never a reason to
// reach for the bare "three" specifier in this package.
import {
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture,
} from "three/webgpu";

import {
  FIXED_TIMESTEP,
  MAX_FRAME_TIME,
  MAX_SUBSTEPS,
  VOXEL_SIZE,
} from "@fgp/shared/sim/constants";
import {
  createPlayerInput,
  Player,
  PLAYER_MASS,
  PlayerMode,
  WALK_HALF_WIDTH,
  WALK_HEIGHT,
} from "@fgp/shared/sim/player";
import { PlayerBody } from "@fgp/shared/sim/playerBody";
import { dropCount } from "@fgp/shared/worldgen/generationSheet";
import { placeRock } from "@fgp/shared/items/rock";
import { itemOfBall, rolledItemOf, spawnRolled } from "@fgp/shared/items/rolledItems";
import {
  putSpeedAt,
  Shake,
  splashAt,
  stainAt,
  ThrownVessels,
  vesselOf,
  type Splat,
} from "@fgp/shared/items/vessel";
import {
  AvatarAction,
  CHUP_CYCLE_SECONDS,
  createAvatarPose,
  SCOOP_CYCLE_SECONDS,
  SHAKE_CYCLE_SECONDS,
} from "@fgp/shared/items/avatarPose";
import {
  HOTBAR_SLOTS,
  Inventory,
  itemDisplayName,
  ItemType,
  itemTypeFromName,
} from "@fgp/shared/items/inventory";
import { createFishingFrame, Fishing } from "@fgp/shared/items/fishing";
import { PICKUP_REACH, PickupField, type Pickup } from "@fgp/shared/items/pickupField";
import {
  CONTAINER_ITEMS,
  CONTAINER_NAMES,
  ContainerField,
  containerKindOfItem,
  inContainerReach,
  isContainerKind,
} from "@fgp/shared/items/container";
import { CraftingBench, RecipeBook } from "@fgp/shared/items/crafting";
import { PlacementPlanner, placementOf, type PlacementPlan } from "@fgp/shared/items/placement";
import { BuildField, createBuildHit, pieceSpecOf } from "@fgp/shared/items/building";
import { PiecePlanner, aimAtSurface, createSurfaceAim } from "@fgp/shared/items/buildPlan";
import { PlacementOrientation } from "@fgp/shared/items/placementControl";
import { ItemCursor } from "@fgp/shared/items/itemCursor";
import {
  PUMP_BUFFER_SECONDS,
  TRAMPOLINE_RADIUS,
  TrampolineField,
  type Trampoline,
} from "@fgp/shared/items/trampoline";
import {
  planRope,
  ROPE_MAX_STRINGS,
  ropeMaxReach,
  ropeSpecFor,
  RopeField,
  BallRopeBody,
  PlayerRopeBody,
  XMAS_LIGHTS,
  type RopeBody,
  type Rope,
  type RopeHit,
  type RopeTie,
  type RopeVec,
} from "@fgp/shared/items/rope";
import { SpringStride } from "@fgp/shared/items/springShoes";
import {
  createSnowballHit,
  SNOW_UNIT_RADIUS,
  SnowballField,
  ThrownSnowballs,
  TrunkQuery,
  type Trunk,
  type Snowball,
} from "@fgp/shared/items/snowball";
import { MapData } from "@fgp/shared/map/mapData";
import {
  applyPlayer,
  applyWorld,
  capturePlayer,
  captureWorld,
  worldRevision,
  type WorldParts,
} from "@fgp/shared/save/gameSave";
import { SceneSolidQuery, type OrientedBody } from "@fgp/shared/sim/sceneQuery";
import {
  CHUNK_METERS,
  createSceneHit,
  DEFAULT_LOAD_RADIUS_CHUNKS,
  HitKind,
  TREE_PART_TRUNK,
  World,
  type Prop,
  type Tree,
} from "@fgp/shared/sim/world";

import { Atmosphere } from "./render/atmosphere.ts";
import { InputState } from "./input/inputState.ts";
import { Leaves } from "./render/leaves.ts";
import { createPieceHit, LogSystem } from "./physics/logSystem.ts";
import { BuildPieceRopeBody, PieceRopeBody } from "./physics/ropeBodies.ts";
import { ThrownSticks } from "./physics/thrownSticks.ts";
import { TrampolineSystem } from "./physics/trampolineSystem.ts";
import { SKATE_BOARD_HEIGHT } from "@fgp/shared/sim/skate";
import { LooseBoard } from "@fgp/shared/sim/looseBoard";
import { LooseBoardsView, SkateboardView } from "./render/skateboardView.ts";
import { TreeLightsView } from "./render/treeLights.ts";
import { RopesView } from "./render/ropeView.ts";
import { FishingView } from "./render/fishingView.ts";
import { SnowballsView, SnowPuffs } from "./render/snowballView.ts";
import { GOO_SPRAY_COLORS, GooStains } from "./render/gooMaterial.ts";
import { VesselsView } from "./render/vesselView.ts";
import { createBiomeWeights } from "@fgp/shared/worldgen/biome";
import { PROP_METRICS, PROP_SECTIONS } from "@fgp/shared/worldgen/props";
import {
  HIT_SPEED,
  isBreakable,
  PROP_DAMAGE,
  propBox,
  propColliders,
  sectionTouching,
  type PropDamageSource,
} from "@fgp/shared/sim/propDamage";
import { DEBUG } from "./debug.ts";
import { BrowserSaveStore } from "./save/browserSaveStore.ts";
import { SaveManager } from "./save/saveManager.ts";
import { loadItemAssets, ROD_TIP_NAME } from "./render/itemAssets.ts";
import type { HeldItemSources } from "./render/heldItems.ts";
import { PhysicsWorld } from "./physics/physicsWorld.ts";
import { CameraPerspective, PlayerCamera } from "./render/playerCamera.ts";
import { PickupRenderer } from "./render/pickupRenderer.ts";
import { loadPropAssets } from "./render/propAssets.ts";
import { PropRenderer } from "./render/propRenderer.ts";
import { PlayerModel } from "./render/playerModel.ts";
import { ArmViewmodel } from "./render/armViewmodel.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { LowResPass } from "./render/n64Pass.ts";
import { nearestify } from "./render/n64Texture.ts";
import { RenderSettingsStore } from "./render/renderSettings.ts";
import { CRUMB_BURST, flakeRgb, GOO_BURST, Snow, SnowFlakeBurst } from "./render/snow.ts";
import { Shatter } from "./render/shatter.ts";
import { FlyingChunks } from "./render/flyingChunks.ts";
import { loadTreeAssets } from "./render/treeAssets.ts";
import { TreeRenderer } from "./render/treeRenderer.ts";
import { createTerrainMaterial } from "./render/terrainMaterial.ts";
import { WorldRenderer } from "./render/worldRenderer.ts";
import { GameAudio } from "./audio/gameAudio.ts";
import {
  AmbienceScheduler,
  landingGain,
  RisingEdge,
  StrideTracker,
} from "./audio/triggers.ts";
import { askAppearance } from "./ui/characterCreate.ts";
import { ControlHints } from "./ui/controlHints.ts";
import { Hotbar } from "./ui/hotbar.ts";
import { InventoryScreen } from "./ui/inventoryScreen.ts";
import { PlacementPreview } from "./render/placementPreview.ts";
import { PieceMeshes } from "./render/pieceMesh.ts";
import { BuildSystem } from "./physics/buildSystem.ts";
import { MapView } from "./ui/mapView.ts";
import { TrickBanner } from "./ui/trickBanner.ts";
import { FrameStats, Hud } from "./ui/hud.ts";
import { WorkerChunkSource } from "./workers/workerChunkSource.ts";

/** Matches the seed the golden fixture was generated with. */
const SEED = 1337;

/** Metres above the ground to spawn, so the player falls onto terrain. */
const SPAWN_CLEARANCE = 2;

/**
 * Scoop tuning, from src/main.cpp. The scoop acts on trees (knocks lights and foliage off),
 * snowbanks and snowballs; it does not dig the ground. The first tick of a gesture raycasts
 * and subsequent ticks reuse that hit point until the eye moves 5cm or the aim turns ~5.7
 * degrees, so holding still scoops one spot rather than walking along the view ray.
 */
/** One scoop per swing of the arms. */
const SCOOP_TICK_SECONDS = SCOOP_CYCLE_SECONDS;
const SCOOP_REACH_METERS = 5;
const SCOOP_REANCHOR_POSITION = 0.05;
const SCOOP_REANCHOR_DIRECTION = 0.995;

/** Two chups per swing cycle, as the C++ build had it. */
const CHUP_TICK_SECONDS = CHUP_CYCLE_SECONDS / 2;

/**
 * Sticks splashed out of a trunk by each chup that lands on it: one, and a
 * chance of a second, flung out towards the swinger's side of the tree.
 */
const STICK_SPLASH_EXTRA_CHANCE = 0.3;
const STICK_SPLASH_SPREAD = 1.2;

/** Spear throw: hold to charge for up to this long; speed runs min..max with the charge. */
const THROW_CHARGE_SECONDS = 1.2;
const THROW_MIN_SPEED = 9;
const THROW_MAX_SPEED = 24;

/**
 * A held log: left mouse bowls it along the ground, right mouse lobs it
 * underhand. Both charge while held, over the same time as the spear: a tap
 * barely rolls it or drops it at your feet, a full charge sends it well off.
 * Speeds in m/s. A bowled log is slowed by rolling resistance (see
 * logSystem.ts): on the flat a tap goes about 10cm, a full charge about 20m.
 */
const BOWL_MIN_SPEED = 0.6;
const BOWL_MAX_SPEED = 8;
const LOB_MIN_SPEED = 2.5;
const LOB_MAX_SPEED = 12;
/** Lob launch angle above the horizon, degrees, shifted by half the look pitch. */
const LOB_ANGLE_DEGREES = 40;
/** A lobbed log tumbles end over end this fast, rad/s. */
const LOB_TUMBLE = 3;

/**
 * A held snowball: left mouse rolls it along the ground (the log's bowl speeds
 * above; where it grows is items/snowball.ts), right mouse puts it overhand,
 * like a shot put: fast and fairly flat, over the same charge time.
 */
const PUT_MIN_SPEED = 9;
const PUT_MAX_SPEED = 26;
/**
 * A rock is hit by a swing (a scoop, a chup, a stick) as a thing of this weight
 * moving this fast; it shares momentum with the rock (Snowball.shove), so a big
 * rock barely stirs and a small one goes.
 */
const SWING_SPEED = 9;
const SWING_MASS = 12;
/** A hit lifts the rock a little off the ground as well as sending it along. */
const SWING_LIFT = 0.25;

/** Snow knocked out of a bank or a rolled snowball is flung out this fast, m/s. */
const SNOW_POP_SPEED = 2.2;
/** Trees this near a rolling or flying snowball are solid to it. */
const SNOW_TRUNK_RADIUS = 4;
/** Snowbanks with their centre this near the player, or a ball of snow, are solid to them. */
const MOUND_GATHER_RADIUS = 4.5;
/** Specks of snow thrown up where a bank or a rolled snowball is hit. */
const SNOW_HIT_PUFF = 7;
/** Snow shaken off a snowman by a blow: flakes, and how fast they leave, m/s. */
const SNOWMAN_HIT_FLAKES = 14;
const SNOWMAN_HIT_FLAKE_SPEED = 2.4;
/** And the burst when a part of one comes off and explodes. */
const SNOWMAN_BREAK_FLAKES = 70;
const SNOWMAN_BREAK_FLAKE_SPEED = 3.5;
/** A ball that has hurt a prop cannot hurt it again for this long, seconds. */
const BALL_HIT_COOLDOWN = 0.4;
/** Crumbs knocked off a gingerbread house by a blow, and by its blowing up; and how fast they leave, m/s. */
const HOUSE_HIT_CRUMBS = 12;
const HOUSE_HIT_CRUMB_SPEED = 2.6;
const HOUSE_BREAK_CRUMBS = 140;
const HOUSE_BREAK_CRUMB_SPEED = 5;
/** Gingerbread, icing and candy: the colours the crumbs come in (browns twice, for more of them). */
const CRUMB_PALETTE = [
  0x9a5a2c, 0x9a5a2c, 0x7a431e, 0xb8743a, 0xb8743a, 0xf4efe6, 0xffffff, 0xd63a3a, 0x2f9e55,
].map(flakeRgb);
/** What was inside a house hops out of it at this speed, m/s. */
const HOUSE_LOOT_HOP = 2;
/** Fizz from a burst can, and the splat of a ball of goo: drops, and how fast they leave, m/s (times the splash). */
const FIZZ_DROPS = 90;
const FIZZ_SPEED = 4;
const SPLAT_DROPS = 70;
const SPLAT_SPEED = 3;
const GOO_PALETTE = GOO_SPRAY_COLORS.map(flakeRgb);

/** Seconds between pickups while E is held, so a leaf pile can be hoovered up. */
const PICKUP_REPEAT_SECONDS = 0.12;
/** Seconds between "full" buzzes while E is held with nowhere to put the thing. */
const PICKUP_FULL_REPEAT_SECONDS = 0.5;

/** Semitones stacked for the orchestra hit on a landed kickflip: octave down, root, fifth, octave, major third. */
const ORCHESTRA_HIT_CHORD = [-12, 0, 7, 12, 16] as const;

/** Sounds farther than this from the player are not heard (m); between, they fade out. */
const HEARING_METERS = 40;
/** A tied string pulled at least this hard (of its maxForce) twangs, and again once it has eased below the low mark. */
const ROPE_TWANG_HIGH = 0.5;
const ROPE_TWANG_LOW = 0.25;
/** Halloween ambience: how much Halloween the player is in before it can play, and the gap between sounds (s). */
const HALLOWEEN_AMBIENCE_THRESHOLD = 0.5;
const HALLOWEEN_AMBIENCE_MIN_SECONDS = 25;
const HALLOWEEN_AMBIENCE_MAX_SECONDS = 70;

/** Trampolines are placed on ground this far out at most, and picked up from this far. */
const TRAMPOLINE_PICKUP_REACH = 4;
/** How far away a tied string of xmas lights can be picked up from, metres. */
const ROPE_PICKUP_REACH = 4;
/** A held string lets go if it is stretched to this many times its length (a respawn, a teleport). */
const ROPE_SNAP_RATIO = 1.7;

/** Field of view added at full skate speed, degrees, for a sense of speed. */
const SKATE_FOV_BOOST = 10;
/** Speed (m/s) at which the boost is full. */
const SKATE_FOV_SPEED = 12;

/** Trees within this of the player are solid to walk into. */
const TRUNK_COLLIDE_RADIUS = 3;

/** Tied strings within this of the player are simulated; farther ones are left as they lie. */
const ROPE_SIM_RADIUS = 40;
/** Tie points sit this far back along the ray from the surface, so the end is not buried in it. */
const ROPE_TIE_STANDOFF = 0.03;

/**
 * Leaves a harvested canopy bursts into, and how far they scatter. A
 * cluster is the whole of a tree's foliage at that height, so it is worth
 * a handful of leaves rather than the one a voxel scoop dropped.
 */
const LEAF_PUFF_COUNT = 5;
const LEAF_PUFF_SPREAD = 0.4;

/** Explored radius around the player, in chunks (3.2m each); kept inside the load radius. */
const MAP_EXPLORE_RADIUS_CHUNKS = 10;
/** Seconds between sweeps that pick up columns whose chunks were still streaming in. */
const MAP_SWEEP_SECONDS = 0.5;
/** Main-thread ms per frame spent redrawing map tiles. */
const MAP_BUDGET_MS = 3;

/** Matches the C++ FOV adjust step on the -/= keys. */
const FOV_STEP = 2;
const FOV_MIN = 50;
const FOV_MAX = 120;

/** Dominant biome, for the HUD readout. */
function biomeLabel(weights: { christmas: number; halloween: number }): string {
  if (weights.christmas > 0.5) return "christmas";
  if (weights.halloween > 0.5) return "halloween";
  if (weights.christmas > 0.05) return "christmas edge";
  if (weights.halloween > 0.05) return "halloween edge";
  return "plain";
}

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing required element: ${selector}`);
  return el;
}

/** A ground texture: loaded like any other, but its colours are sRGB as painted. */
async function loadGroundTexture(url: string): Promise<Texture> {
  const map = await loadTexture(url);
  map.colorSpace = SRGBColorSpace;
  return map;
}

function loadTexture(url: string): Promise<Texture> {
  return new TextureLoader().loadAsync(url).then(nearestify);
}

/**
 * Load radius in chunks, overridable via `?radius=N` -- the quickest way to
 * tell "slow because there is a lot of terrain" apart from "slow for some
 * other reason".
 */
function loadRadiusFromUrl(): number {
  const raw = new URLSearchParams(window.location.search).get("radius");
  if (raw === null) return DEFAULT_LOAD_RADIUS_CHUNKS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LOAD_RADIUS_CHUNKS;
}

async function start(): Promise<void> {
  const audio = new GameAudio(new URLSearchParams(window.location.search).get("audio") !== "0");
  const appearance = await askAppearance(requireElement<HTMLDivElement>("#charcreate"), () =>
    audio.play("menuAccept", { variance: 1 }),
  );

  // Singleplayer saves live in this browser (see save/). `?save=0` plays without
  // reading or writing one; `?reset=1` throws the saved game away and starts over.
  const urlParams = new URLSearchParams(window.location.search);
  const saving = urlParams.get("save") !== "0";
  const saveStore = new BrowserSaveStore();
  if (saving && urlParams.get("reset") === "1") {
    await saveStore.clear();
    urlParams.delete("reset");
    const query = urlParams.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query === "" ? "" : `?${query}`}`);
  }
  const [playerSave, worldSave] = saving
    ? await Promise.all([saveStore.loadPlayer(), saveStore.loadWorld()])
    : [undefined, undefined];

  const canvas = requireElement<HTMLCanvasElement>("#viewport");
  const bundle = await createRenderer(canvas);
  const { renderer } = bundle;

  const statsPanel = requireElement<HTMLDivElement>("#stats");
  const hud = new Hud(statsPanel);
  const itemControls = new ControlHints(requireElement<HTMLDivElement>("#item-controls"));
  const mouseHint = requireElement<HTMLDivElement>("#hint");
  const stats = new FrameStats();
  hud.set("BACKEND", bundle.backend + (bundle.forcedWebGL ? " (forced via ?gl)" : ""));

  const scene = new Scene();

  // The voxel terrain shader is unlit, but the player model is not. Both
  // light levels are driven per frame by the Atmosphere, which is also what
  // sets the sky colour -- see render/atmosphere.ts.
  const hemisphere = new HemisphereLight(0xcfe4f5, 0x4a3a2a, 2.2);
  scene.add(hemisphere);
  const sun = new DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  // Far plane well past the load radius: terrain fades out at the
  // atmosphere's fog distance, and clipping it closer than that would undo
  // the fade it exists to hide.
  const camera = new PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 400);

  // The N64 picture: the scene is drawn small and scaled up (render/n64Pass.ts). The picture's
  // shape, not the window's, sets the camera's aspect (the 4:3 / 16:9 option).
  const renderSettings = new RenderSettingsStore();
  const lowRes = new LowResPass(renderer, renderSettings, (aspect) => {
    camera.aspect = aspect;
    camera.updateProjectionMatrix();
  });

  // assets/ is served from the repo root via Vite's publicDir, so these paths
  // mirror the C++'s asset layout rather than being a second copy.
  const cobble = await loadTexture("/textures/cobble.png");
  const terrainMaterial = createTerrainMaterial({
    grass: await loadGroundTexture("/textures/grass2_TWP.png"),
    dirt: await loadGroundTexture("/textures/dirt1_twp.png"),
    snow: await loadGroundTexture("/textures/snow_64x64.png"),
  });
  const material = terrainMaterial.material;
  const bushTexture = await loadTexture("/billboard/bush.png");
  const leafIcon = await loadTexture("/icons/leaf.png");
  const itemAssets = await loadItemAssets();
  const propAssets = await loadPropAssets();
  const heldSources: HeldItemSources = {
    assets: itemAssets,
    icons: { [ItemType.Leaf]: leafIcon },
    props: propAssets,
  };
  const treeAssets = await loadTreeAssets();

  const radius = loadRadiusFromUrl();
  const source = new WorkerChunkSource(SEED);
  const world = new World(SEED, source, radius);
  const stumpTexture = await loadTexture("/textures/treestump.png");
  const treeRenderer = new TreeRenderer(scene, treeAssets, cobble, stumpTexture);
  /** What every container holds. Its look (full or empty) follows it onto the prop. */
  const containers = new ContainerField();
  const propRenderer = new PropRenderer(scene, propAssets, containers);
  containers.onEmptyChanged = (id, empty) => propRenderer.setEmpty(id, empty);
  const worldRenderer = new WorldRenderer(scene, material, treeRenderer, propRenderer, bushTexture);
  hud.set("WORKERS", String(source.workerCount));

  const atmosphere = new Atmosphere(scene, terrainMaterial, hemisphere, sun, radius);
  const snow = new Snow(scene);
  /** The same flakes as the weather, thrown out where a snowman is hit. */
  const flakeBurst = new SnowFlakeBurst(scene);
  /** Parts knocked off a snowman, in flight until they burst. */
  const flyingChunks = new FlyingChunks(scene);
  /** Crumbs and sugar: the same flakes again, heavier, in gingerbread colours. */
  const crumbBurst = new SnowFlakeBurst(scene, CRUMB_BURST);
  /** A house that has been hit to pieces, in pieces. */
  const shatter = new Shatter(scene);
  const leafSheet = await loadTexture("/textures/falling_leaf_1_32x32.png");
  const leaves = new Leaves(
    scene,
    leafSheet,
    (x, z) =>
      (world.surfaceHeightVoxels(Math.floor(x / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE)) + 1) *
      VOXEL_SIZE,
  );

  // Everything that collides goes through this rather than the World
  // directly: terrain plus whatever settled rigid bodies the player is
  // allowed to stand on.
  const sceneQuery = new SceneSolidQuery(world);

  const spawnY = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE + SPAWN_CLEARANCE;
  const player = new Player(0, spawnY, 0);
  /** What elastic things (strung xmas lights) are pushed by, and push back on. */
  const elasticColliders = [new PlayerBody(player)];
  const playerCamera = new PlayerCamera();
  const playerModel = await PlayerModel.load(scene, appearance, heldSources);
  const arm = await ArmViewmodel.load(appearance.skin, heldSources);
  hud.set("NAME", appearance.name);

  const inventory = new Inventory();
  const hotbar = new Hotbar(requireElement<HTMLDivElement>("#hotbar"), heldSources);
  const pickups = new PickupField();
  const pickupRenderer = new PickupRenderer(scene, itemAssets, { [ItemType.Leaf]: leafIcon }, propAssets);
  const trampolines = new TrampolineField();
  const trampolineSystem = new TrampolineSystem(scene, itemAssets, trampolines);
  // Building pieces: the sim's field of them (saved, climbed, hit); BuildSystem below makes them physical.
  const buildField = new BuildField();
  const thrown = new ThrownSticks(scene, itemAssets, world, pickups, trampolines, buildField);
  thrown.onHit = (x, y, z, hit, propId) => {
    audio.play("stickTick", {
      gain: hearing(x, y, z),
      pitch: hit === "ground" ? -7 : hit === "mat" ? 5 : 0,
      variance: 1.5,
    });
    if (hit === "prop") hurtProp(propId, x, y, z, "stick");
  };
  const skateboardView = new SkateboardView(scene, itemAssets);
  const looseBoardsView = new LooseBoardsView(scene, itemAssets);
  /** Boards that bailed riders left rolling; each becomes a pickup when it stops. */
  const looseBoards: LooseBoard[] = [];
  /** Snow: rolled snowballs (rolling or lying), ones in flight, and the puffs they burst into. */
  const snowballs = new SnowballField();
  // The world scatters rocks as it loads chunks; from then on they are the field's.
  worldRenderer.onRock = (rock) => {
    placeRock(snowballs, rock.id, rock.x, rock.y, rock.z, rock.scale);
  };
  const flyingSnow = new ThrownSnowballs();
  /** Cans of mountain lightning and balls of goo in flight, how shaken the one in the hand is, and what they leave. */
  const vessels = new ThrownVessels();
  const shake = new Shake();
  const vesselsView = new VesselsView(scene, itemAssets);
  const gooSpray = new SnowFlakeBurst(scene, GOO_BURST);
  const gooStains = new GooStains(scene);
  const trunkQuery = new TrunkQuery(sceneQuery);
  const snowballsView = new SnowballsView(scene, itemAssets);
  const snowPuffs = new SnowPuffs(scene);
  /** Xmas lights tied between two things, and the first end of one being tied. */
  const ropes = new RopeField();
  const ropesView = new RopesView(scene, itemAssets.ropeParts);
  const treeLights = new TreeLightsView(scene, itemAssets.ropeParts);
  treeRenderer.lights = treeLights;
  /** The fishing rod's cast and line, and the world the rod sees this frame (its settings: items/fishing.ts). */
  const fishing = new Fishing();
  const fishingFrame = createFishingFrame();
  const fishingInput = { active: false, cast: false, reel: false };
  const fishingView = new FishingView(scene, itemAssets.ropeParts, fishing);
  /** Where the line leaves the rod as drawn, world space, as of the last frame; unset until the rod has been seen. */
  const rodTip = new Vector3();
  let rodTipSeen = false;
  let ropeFirst: RopeTie | undefined;
  /** Strings run together into the one being placed: right mouse adds one. */
  let ropeStrings = 1;
  /** The player's hand as the free end of the string being placed. */
  const handBody = new PlayerRopeBody(player, elasticColliders[0]);
  /**
   * While one end is tied, the string is a real rope from there to the player's
   * hand, as long as the strings run together reach: it hangs, drags what it is
   * tied to, and pulls the player up short.
   */
  let ropeLive: Rope | undefined;
  const handScratch: RopeVec = { x: 0, y: 0, z: 0 };
  /** (Re)lays the live rope from the first tie to the hand at the current number of strings, keeping its shape. */
  const runLiveRope = (): void => {
    if (ropeFirst === undefined) return;
    const spec = ropeSpecFor(XMAS_LIGHTS, ropeStrings);
    handBody.tiePoint(handScratch);
    const rope = ropes.add(
      spec,
      ropeFirst,
      { x: handScratch.x, y: handScratch.y, z: handScratch.z, body: handBody },
      ropeMaxReach(spec),
    );
    if (ropeLive !== undefined) {
      rope.seedFrom(ropeLive);
      ropes.remove(ropeLive);
    }
    ropeLive = rope;
  };
  const ropeHit: RopeHit = { distance: 0 };
  const ropeScratch: RopeVec = { x: 0, y: 0, z: 0 };
  const snowballHit = createSnowballHit();
  const snowScratch = createBiomeWeights();
  const snowTrees: Tree[] = [];
  const nearProps: Prop[] = [];
  /** Solid cylinders of the snowmen near something, for it to bump into. */
  const colliderScratch: Trunk[] = [];
  /** When each ball last hurt something, by the clock of the fixed steps. */
  const ballHitAt = new WeakMap<object, number>();
  let ballHitClock = 0;
  const snowYield = { x: 0, z: 0 };
  /** Snow sticks to the ground in the Christmas biome only. */
  const snowAt = (x: number, z: number): boolean => {
    world.biomeAtMeters(x, z, snowScratch);
    return snowScratch.christmas > 0.5;
  };
  /** How far the rider is lifted onto the board, eased in when it is equipped. */
  let rideLift = 0;
  /** Eased camera height while rolling, so the 10cm terrain steps do not jolt the view. */
  let cameraY = 0;
  let wasSkateView = false;
  let perspectiveBeforeSkate: CameraPerspective = CameraPerspective.FirstPerson;

  const terrainAt = (x: number, z: number): number =>
    world.surfaceHeightVoxels(Math.floor(x / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE)) * VOXEL_SIZE;
  /** What things land on: terrain, or a trampoline mat standing over it. */
  const groundAt = (x: number, z: number): number =>
    Math.max(terrainAt(x, z), trampolines.topAt(x, z) ?? -Infinity);

  // Bring back the last session, before the first chunk is asked for: the world's
  // edits must be in before terrain streams, and the player's spot decides which
  // terrain that is.
  // The bodies and meshes that make the building pieces physical; thrown things hit them through the trunk query.
  const pieceMeshes = new PieceMeshes(itemAssets);
  const buildSystem = new BuildSystem(
    buildField,
    world,
    sceneQuery,
    scene,
    pieceMeshes,
    Math.max(8, (radius - 1.5) * CHUNK_METERS),
    trunkQuery.solids,
  );
  player.rails = buildField;
  const worldParts: WorldParts = { world, containers, trampolines, pieces: buildField, pickups };
  if (worldSave !== undefined) applyWorld(worldSave, worldParts, groundAt, performance.now() / 1000);
  /** Which items the player has held, hence which recipes they know. */
  const recipes = new RecipeBook();
  if (playerSave !== undefined) applyPlayer(playerSave, player, inventory, recipes);
  const saveManager = saving
    ? new SaveManager(saveStore, {
        capturePlayer: () => capturePlayer(player, inventory, recipes),
        captureWorld: () => captureWorld(worldParts),
        worldRevision: () => worldRevision(worldParts),
      })
    : undefined;
  hud.set("SAVE", saving ? (playerSave === undefined ? "new game" : "continued") : "off (?save=0)");

  // Debug start: a trampoline in the inventory to place. See debug.ts. Only for a
  // new game: a continued one already has whatever it had when it was saved.
  if (DEBUG && playerSave === undefined) {
    // The building pieces first, so they are on the hotbar (slots 2-6) to try straight away.
    inventory.tryAdd(ItemType.Ladder, 6);
    inventory.tryAdd(ItemType.Plywood, 12);
    inventory.tryAdd(ItemType.Log, 10);
    inventory.tryAdd(ItemType.Toobifer, 12);
    inventory.tryAdd(ItemType.Wheel, 4);
    inventory.tryAdd(ItemType.Trampoline);
    inventory.tryAdd(ItemType.Skateboard);
    inventory.tryAdd(ItemType.Snowball, 20);
    inventory.tryAdd(ItemType.XmasLights, 10);
    inventory.tryAdd(ItemType.FishingRod);
    inventory.tryAdd(ItemType.Rock, 20);
    inventory.tryAdd(ItemType.MountainLightning, 10);
    inventory.tryAdd(ItemType.Eggnog, 10);
    inventory.tryAdd(ItemType.Coal, 10);
    inventory.tryAdd(ItemType.Goo, 10);
    inventory.tryAdd(ItemType.Metal, 10);
    inventory.tryAdd(ItemType.Candy, 10);
    inventory.tryAdd(ItemType.SpringShoes);
    inventory.tryAdd(ItemType.PresentSmall, 2);
    inventory.tryAdd(ItemType.PresentBig, 2);
    inventory.tryAdd(ItemType.CandyBucket, 2);
  }
  if (DEBUG) hud.set("DEBUG", "ON");

  /** Volume 0..1 for a sound at a point: full beside the player, fading to nothing at HEARING_METERS. */
  const hearing = (x: number, y: number, z: number): number => {
    const away = Math.hypot(x - player.x, y - player.y, z - player.z);
    return away >= HEARING_METERS ? 0 : (1 - away / HEARING_METERS) ** 2;
  };

  /** Drops an item at a point, optionally thrown out, to land on the terrain. */
  const dropItem = (
    type: ItemType,
    x: number,
    y: number,
    z: number,
    vx = 0,
    vy = 0,
    vz = 0,
  ): void => {
    pickups.spawn(type, x, y, z, groundAt(x, z), performance.now() / 1000, vx, vy, vz);
  };

  /** The crafting inputs and the stack on the mouse; both belong to the inventory screen. */
  const crafting = new CraftingBench(recipes);
  const itemCursor = new ItemCursor();
  const inventoryScreen = new InventoryScreen(
    requireElement<HTMLDivElement>("#inventory"),
    inventory,
    crafting,
    itemCursor,
    heldSources,
    {
      sound: (name) => {
        if (name === "pick") audio.play("pickup", { gain: 0.8, variance: 1 });
        else if (name === "place") audio.play("pickupAlt", { gain: 0.8, variance: 1 });
        else if (name === "cancel") audio.play("menuBack", { gain: 0.7 });
        else audio.play("craftError", { gain: 0.7 });
      },
      // Nowhere to put it: it drops at the feet, spread out a little.
      drop: (stack) => {
        for (let i = 0; i < stack.count; i++) {
          const angle = Math.random() * Math.PI * 2;
          dropItem(
            stack.type,
            player.x + player.frontX * 0.8,
            player.y + 1.2,
            player.z + player.frontZ * 0.8,
            Math.cos(angle) * 0.8,
            1.5,
            Math.sin(angle) * 0.8,
          );
        }
      },
    },
  );
  /** Where a held placeable would go and whether it can, and the see-through copy that shows it. */
  const planner = new PlacementPlanner(world, trampolines);
  const piecePlanner = new PiecePlanner(world, buildField);
  const placementPreview = new PlacementPreview(scene, { ...heldSources, pieces: pieceMeshes });
  /** The player's own turn of what they are placing (scroll steps it, R and the mouse turn it freely). */
  const orientation = new PlacementOrientation();
  const surfaceAim = createSurfaceAim();
  const buildHit = createBuildHit();
  let orientedItem: ItemType | undefined;
  /** A short click on a log places it; a held one bowls (a log has both uses on the left button). */
  const TAP_PLACE_CHARGE = 0.12;
  let tapPlace = false;
  const reachableContainers: Prop[] = [];
  /** The container the player can open: the one under the crosshair if it is in reach, else the nearest. */
  const containerInReach = (preferredId: number): Prop | undefined => {
    world.propsNear(player.x, player.z, PICKUP_REACH + 3, reachableContainers);
    let best: Prop | undefined;
    let bestDistance = Infinity;
    for (const prop of reachableContainers) {
      if (!isContainerKind(prop.kind) || !inContainerReach(prop, player.x, player.y, player.z)) continue;
      const distance = prop.id === preferredId ? -1 : Math.hypot(prop.x - player.x, prop.z - player.z);
      if (distance < bestDistance) {
        best = prop;
        bestDistance = distance;
      }
    }
    return best;
  };
  const openInventory = (preferredContainerId = -1): void => {
    const prop = containerInReach(preferredContainerId);
    inventoryScreen.show(
      prop !== undefined && isContainerKind(prop.kind)
        ? { kind: prop.kind, storage: containers.storageFor(prop) }
        : undefined,
    );
    hotbar.setVisible(false);
    input.release();
    audio.play("inventoryOpen");
  };
  const closeInventory = (): void => {
    inventoryScreen.hide();
    hotbar.setVisible(true);
    input.capture(true);
    audio.play("inventoryClose");
  };
  /** Puts the held placeable down at `plan` (already known to be a valid spot). False if it could not be. */
  const placeHeld = (type: ItemType, plan: PlacementPlan): boolean => {
    if (type === ItemType.Trampoline) {
      if (trampolines.place(plan.x, plan.y, plan.z) === undefined) return false;
      inventory.tryConsumeSelected();
      audio.play("trampolineSet", { pitch: -3 });
      return true;
    }
    if (pieceSpecOf(type) !== undefined) {
      const spec = pieceSpecOf(type);
      if (spec === undefined || !inventory.tryConsumeSelected()) return false;
      // A piece that grips (a ladder) is held where it is put; the rest are set down to settle under physics.
      buildField.place(type, plan.x, plan.y, plan.z, { x: plan.qx, y: plan.qy, z: plan.qz, w: plan.qw }, spec.grips);
      audio.play("trampolineSet", { pitch: type === ItemType.Ladder ? 1 : -1, variance: 1 });
      return true;
    }
    const container = containerKindOfItem(type);
    if (container !== undefined) {
      if (!inventory.tryConsumeSelected()) return false;
      world.addProp(container, plan.x, plan.y, plan.z, plan.yaw, PROP_METRICS[container].scale, worldRenderer);
      audio.play("trampolineSet", { pitch: 3 });
      return true;
    }
    return false;
  };

  /**
   * Sticks flung out of a trunk by a chup landing at (x, y, z), towards the
   * side the swing came from.
   */
  const splashSticks = (x: number, y: number, z: number): void => {
    const count = 1 + (Math.random() < STICK_SPLASH_EXTRA_CHANCE ? 1 : 0);
    const base = Math.atan2(player.z - z, player.x - x);
    for (let i = 0; i < count; i++) {
      const angle = base + (Math.random() - 0.5) * 2 * STICK_SPLASH_SPREAD;
      const speed = 1.5 + Math.random() * 1.5;
      dropItem(
        ItemType.Stick,
        x,
        y,
        z,
        Math.cos(angle) * speed,
        2.5 + Math.random(),
        Math.sin(angle) * speed,
      );
    }
  };

  /** Strings of xmas lights shaken off a tree, dropped round (x, y, z). */
  const scatterLights = (x: number, y: number, z: number, count: number): void => {
    const base = Math.atan2(player.z - z, player.x - x);
    for (let i = 0; i < count; i++) {
      const angle = base + (Math.random() - 0.5) * 2 * STICK_SPLASH_SPREAD;
      const speed = 0.8 + Math.random() * 1.2;
      dropItem(
        ItemType.XmasLights,
        x,
        y,
        z,
        Math.cos(angle) * speed,
        1.5 + Math.random(),
        Math.sin(angle) * speed,
      );
    }
  };

  /** Pops `count` snowballs of snow out of (x, y, z), thrown out towards the player. */
  const popSnow = (x: number, y: number, z: number, count: number, spread: number): void => {
    const toward = Math.atan2(player.z - z, player.x - x);
    for (let i = 0; i < count; i++) {
      const angle = toward + (Math.random() - 0.5) * 2.2;
      const speed = SNOW_POP_SPEED * (0.5 + Math.random());
      dropItem(
        ItemType.Snowball,
        x + Math.cos(angle) * spread * Math.random(),
        y,
        z + Math.sin(angle) * spread * Math.random(),
        Math.cos(angle) * speed,
        2.5 + Math.random(),
        Math.sin(angle) * speed,
      );
    }
    snowPuffs.burst(x, y, z, Math.cos(toward), 0.6, Math.sin(toward), SNOW_HIT_PUFF, 2);
    audio.play("snowPoof", { variance: 2, gain: 0.8 });
  };

  /** A hit on a rolled snowball: it gives up some snow and shrinks to match. */
  const hitSnowball = (ball: Snowball): void => {
    if (itemOfBall(ball) !== undefined) {
      // Nothing to get out of a rock or a carton: the blow moves it, by its weight.
      ball.shove(
        player.frontX * SWING_SPEED,
        Math.max(0, player.frontY) * SWING_SPEED + SWING_LIFT * SWING_SPEED,
        player.frontZ * SWING_SPEED,
        SWING_MASS,
      );
      audio.play("stickTick", { variance: 2, gain: 0.8 });
      return;
    }
    const toward = Math.atan2(player.z - ball.z, player.x - ball.x);
    const given = ball.harvest();
    popSnow(
      ball.x + Math.cos(toward) * ball.radius * 0.8,
      ball.y + ball.radius * 0.2,
      ball.z + Math.sin(toward) * ball.radius * 0.8,
      given,
      0.2,
    );
  };

  /**
   * A blow on a prop made of parts (a snowman), landing at (x, y, z): the snow
   * it knocks off flies, and a part that has taken all it can comes off, taking
   * the parts above it, and explodes into snow (see `onSectionBroken`).
   */
  const hurtProp = (propId: number, x: number, y: number, z: number, source: PropDamageSource): void => {
    const prop = world.getProp(propId);
    if (prop === undefined || !isBreakable(prop.kind)) return;
    if (PROP_METRICS[prop.kind].breakable !== undefined) {
      hurtHouse(prop, x, y, z, source);
      return;
    }
    const hurt = world.damageProp(propId, y, PROP_DAMAGE[source], worldRenderer);
    if (hurt === undefined) return;

    // Thrown out from the snowman's middle, through where it was hit.
    let outX = x - prop.x;
    let outZ = z - prop.z;
    let outLength = Math.hypot(outX, outZ);
    if (outLength < 1e-3) {
      outX = player.x - prop.x;
      outZ = player.z - prop.z;
      outLength = Math.max(1e-3, Math.hypot(outX, outZ));
    }
    flakeBurst.burst(x, y, z, outX / outLength, 0.4, outZ / outLength, SNOWMAN_HIT_FLAKES, SNOWMAN_HIT_FLAKE_SPEED);
    audio.play("snowPoof", { variance: 2, gain: 0.5 * hearing(x, y, z) });

    const top = hurt.broken[hurt.broken.length - 1];
    for (const drop of hurt.drops) {
      const type = itemTypeFromName(drop.item);
      if (type === undefined || top === undefined) continue;
      for (let i = 0, n = dropCount(drop, Math.random()); i < n; i++) {
        const angle = Math.random() * Math.PI * 2;
        dropItem(type, top.x, top.y, top.z, Math.cos(angle) * 0.8, 2.5, Math.sin(angle) * 0.8);
      }
    }
  };

  /**
   * A can or a ball of goo has hit something hard enough to burst: it sprays
   * green, as much as it was shaken, and goo leaves a stain on the surface.
   */
  const burstVessel = (splat: Splat): void => {
    const splash = splashAt(splat.spec, splat.shake);
    const goo = splat.spec.item === ItemType.Goo;
    const heard = hearing(splat.x, splat.y, splat.z);
    gooSpray.burst(
      splat.x,
      splat.y,
      splat.z,
      splat.nx,
      splat.ny,
      splat.nz,
      Math.round((goo ? SPLAT_DROPS : FIZZ_DROPS) * splash),
      (goo ? SPLAT_SPEED : FIZZ_SPEED) * Math.sqrt(splash),
      GOO_PALETTE,
    );
    if (goo) {
      audio.play("snowPoof", { gain: heard, pitch: -9, variance: 1.5 });
      audio.play("hit2", { gain: 0.5 * heard, pitch: -6, variance: 1 });
      // The surface it met is a sphere's radius back from where the sphere stopped.
      const stain = stainAt(splat.spec, splat.shake);
      const r = splat.spec.radius;
      gooStains.add(splat.x - splat.nx * r, splat.y - splat.ny * r, splat.z - splat.nz * r, splat.nx, splat.ny, splat.nz, stain);
    } else {
      audio.play("hit2", { gain: heard, pitch: 7, variance: 1.5 });
      audio.play("snowPoof", { gain: heard, pitch: 12, variance: 2 });
    }
    for (const prop of world.propsNear(splat.x, splat.z, 3, nearProps)) {
      if (sectionTouching(prop, splat.x, splat.y, splat.z, 0.1) >= 0) {
        hurtProp(prop.id, splat.x, splat.y, splat.z, "snowball");
        break;
      }
    }
  };

  /**
   * A blow on a breakable prop (a gingerbread house), landing at (x, y, z):
   * crumbs fly off it, and when it has taken all it can it explodes into its
   * triangles (see `onShattered`) and what was inside hops out.
   */
  const hurtHouse = (prop: Prop, x: number, y: number, z: number, source: PropDamageSource): void => {
    const hurt = world.damageBreakable(prop.id, PROP_DAMAGE[source], worldRenderer);
    if (hurt === undefined) return;

    let outX = x - prop.x;
    let outZ = z - prop.z;
    let outLength = Math.hypot(outX, outZ);
    if (outLength < 1e-3) {
      outX = player.x - prop.x;
      outZ = player.z - prop.z;
      outLength = Math.max(1e-3, Math.hypot(outX, outZ));
    }
    crumbBurst.burst(x, y, z, outX / outLength, 0.4, outZ / outLength, HOUSE_HIT_CRUMBS, HOUSE_HIT_CRUMB_SPEED, CRUMB_PALETTE);
    audio.play("hit4", { variance: 2, gain: 0.8 * hearing(x, y, z), pitch: 3 });
    if (!hurt.destroyed) return;

    const middleY = prop.y + prop.height * 0.3;
    audio.play("treeBreak", { variance: 1, gain: hearing(prop.x, middleY, prop.z), pitch: 2 });
    crumbBurst.burst(prop.x, middleY, prop.z, 0, 1, 0, HOUSE_BREAK_CRUMBS, HOUSE_BREAK_CRUMB_SPEED, CRUMB_PALETTE);
    for (const name of hurt.released) {
      const type = itemTypeFromName(name);
      if (type === undefined) continue;
      const angle = Math.random() * Math.PI * 2;
      dropItem(type, prop.x, prop.y + 0.5, prop.z, Math.cos(angle) * HOUSE_LOOT_HOP, 3, Math.sin(angle) * HOUSE_LOOT_HOP);
    }
  };

  /** A house is being blown apart: its model goes to pieces. */
  propRenderer.onShattered = (prop, model) => {
    shatter.explode(model, prop.x, prop.y + prop.height * 0.3, prop.z);
  };

  /** A snowman part has come off: it flies away from the player and bursts into snow. */
  propRenderer.onSectionBroken = (prop, index, piece) => {
    const section = PROP_SECTIONS[prop.kind]?.[index];
    if (section === undefined) return;
    const radius = section.radius * prop.scale;
    let awayX = prop.x - player.x;
    let awayZ = prop.z - player.z;
    const away = Math.max(1e-3, Math.hypot(awayX, awayZ));
    awayX /= away;
    awayZ /= away;
    const speed = 3 + Math.random() * 2;
    flyingChunks.launch(
      piece,
      radius,
      awayX * speed + (Math.random() - 0.5) * 1.5,
      3 + Math.random() * 1.5,
      awayZ * speed + (Math.random() - 0.5) * 1.5,
      (x, y, z) => {
        popSnow(x, y, z, section.snow, radius * 0.5);
        flakeBurst.burst(x, y, z, 0, 0.8, 0, SNOWMAN_BREAK_FLAKES, SNOWMAN_BREAK_FLAKE_SPEED);
      },
    );
  };

  /**
   * One swing at a prop, landing at (x, y, z): its resources, as the sheet
   * says, and, if it is made of parts, damage to the one hit. A chup does both;
   * a scoop only gets resources out of something made to be scooped.
   */
  const harvestPropAt = (
    propId: number,
    x: number,
    y: number,
    z: number,
    source: "chup" | "scoop",
  ): void => {
    const prop = world.getProp(propId);
    const scoopable = prop !== undefined && PROP_METRICS[prop.kind].scoopable === true;
    if (prop !== undefined && !scoopable && source === "chup") {
      audio.play("stickTick", { variance: 2 });
    }
    if (source === "chup" || scoopable) {
      const got = world.harvestPropYield(propId, Math.random, worldRenderer);
      const type = got === undefined ? undefined : itemTypeFromName(got.item);
      if (prop !== undefined && got !== undefined && type !== undefined) {
        if (type === ItemType.Snowball) popSnow(prop.x, y, prop.z, got.count, 0.6);
        else for (let i = 0; i < got.count; i++) dropItem(type, prop.x, y, prop.z);
      }
    }
    hurtProp(propId, x, y, z, source);
  };

  // Jolt's WASM is fetched and compiled asynchronously. The game does not
  // wait for it: terrain, movement and digging have nothing to do with
  // rigid bodies, and a second of blank screen to load a module that is
  // only needed once the player chops something is a bad trade. Chopping
  // before it lands just removes the piece.
  let logs: LogSystem | undefined;
  let physics: PhysicsWorld | undefined;
  void PhysicsWorld.create()
    .then((created) => {
      physics = created;
      logs = new LogSystem(created, world, sceneQuery, scene, dropItem, itemAssets);
      buildSystem.attachPhysics(created, logs);
      logs.onImpact = (x, y, z, strength) => {
        audio.play("logImpact", {
          gain: hearing(x, y, z) * Math.min(1, 0.3 + strength / 12),
          variance: 2,
        });
      };
      treeRenderer.onFelled = (piece) => {
        // Falls away from whoever cut it: spinning about the horizontal
        // axis at right angles to the line from the player to the tree.
        let awayX = piece.x - player.x;
        let awayZ = piece.z - player.z;
        if (Math.hypot(awayX, awayZ) < 1e-3) awayX = 1;
        const length = Math.hypot(awayX, awayZ);
        awayX /= length;
        awayZ /= length;
        logs?.spawnFelled(piece, awayZ, -awayX);
      };
      hud.set("PHYSICS", "jolt");
    })
    .catch((err: unknown) => {
      hud.set("PHYSICS", `unavailable: ${String(err)}`);
    });

  const mapData = new MapData();
  const mapView = new MapView(requireElement<HTMLDivElement>("#map"));
  const mapRadius = Math.min(MAP_EXPLORE_RADIUS_CHUNKS, Math.max(2, radius - 2));
  let mapChunkX = Number.NaN;
  let mapChunkZ = Number.NaN;
  let mapSweepAt = 0;
  let mapWasOpen = false;

  const input = new InputState(canvas);
  input.attach();
  const playerInput = createPlayerInput();

  installResizeHandler(bundle, (w, h) => {
    lowRes.resize(w, h);
  });

  // Nothing is awaited before the loop starts. The initial load is just the
  // first streaming update: chunks are submitted to the workers here and
  // arrive over the next second or so, nearest-first, while the frame loop
  // keeps running.
  world.update(player.x, player.z, worldRenderer);

  let lastTime = performance.now() / 1000;
  let worstDrainMs = 0;

  /**
   * Leftover simulation time, carried between frames. Physics runs at a
   * fixed 120Hz regardless of display rate: at 10cm voxels, integrating a
   * raw frame delta in one step tunnels the player straight through terrain.
   */
  let accumulator = 0;

  // Previous and current simulated feet position, for render interpolation.
  // Without this a 60Hz display shows whichever 120Hz substep happened to
  // land last, which reads as a fine vertical shimmer while walking.
  // Physics stays frozen until the chunk under the player exists. Without
  // this the player free-falls through an empty world during the ~1s
  // asynchronous initial load, drops past the kill plane, respawns, and
  // falls again -- a loop that only ends when terrain happens to arrive.
  let spawned = false;
  /** Seconds left in which a landing still counts as timed with a jump press. */
  let jumpBuffer = 0;
  const springStride = new SpringStride();
  /** The spring shoes are the selected item this frame. */
  let springShoesOn = false;

  // Sound: things that happen inside the sim are noticed by watching their counters.
  const stride = new StrideTracker();
  const twangs = new RisingEdge<object>(ROPE_TWANG_HIGH, ROPE_TWANG_LOW);
  const halloweenAmbience = new AmbienceScheduler(
    HALLOWEEN_AMBIENCE_MIN_SECONDS,
    HALLOWEEN_AMBIENCE_MAX_SECONDS,
    HALLOWEEN_AMBIENCE_THRESHOLD,
  );
  let seenBails = player.skate.bails;
  let seenOllies = player.skate.ollies;
  let seenFlips = player.skate.flips;
  let seenFlipsLanded = player.skate.flipsLanded;
  let seenPushes = player.skate.pushes;
  let seenRespawns = player.respawns;
  const trickBanner = new TrickBanner(requireElement<HTMLDivElement>("#overlay"), "/icons/skateboard_sick.png");

  const spawnSurface = (): number => world.surfaceHeightVoxels(0, 0);

  let prevX = player.x;
  let prevY = player.y;
  let prevZ = player.z;

  const crosshair = requireElement<HTMLDivElement>("#crosshair");

  // Scoop/chup state. `hit` doubles as the crosshair readout's source, so
  // it is refreshed once a frame whether or not the player is acting.
  const hit = createSceneHit();
  const pieceHit = createPieceHit();
  let chupCooldown = 0;
  let throwCharge = 0;
  let throwSlot = -1;
  /** The throw being charged (Charge is the spear), and the button that holds it. */
  let throwKind: AvatarAction = AvatarAction.Charge;
  let throwButton = -1;

  /**
   * Lets go of a held log. Bowled: set down just ahead of you, lying across
   * your path and rolling, the spin matched to the speed so it grips rather
   * than skids. Lobbed: from waist height, up and out in an arc, tumbling.
   */
  const throwLog = (bowl: boolean, charge: number): void => {
    const flat = Math.max(1e-3, Math.hypot(player.frontX, player.frontZ));
    const fx = player.frontX / flat;
    const fz = player.frontZ / flat;
    // Right of the facing; the log lies along it, so it rolls forward.
    const rightX = -fz;
    const rightZ = fx;
    const radius = itemAssets.logRadius;
    const across = new Quaternion().setFromUnitVectors(
      new Vector3(0, 1, 0),
      new Vector3(rightX, 0, rightZ),
    );
    const rotation: [number, number, number, number] = [across.x, across.y, across.z, across.w];

    let x: number;
    let y: number;
    let z: number;
    let vx: number;
    let vy: number;
    let vz: number;
    let spin: number;
    if (bowl) {
      const speed = BOWL_MIN_SPEED + (BOWL_MAX_SPEED - BOWL_MIN_SPEED) * charge;
      x = player.x + fx * 0.8;
      z = player.z + fz * 0.8;
      y = Math.max(player.y, groundAt(x, z)) + radius + 0.04;
      vx = fx * speed + player.vx;
      vy = 0;
      vz = fz * speed + player.vz;
      // Rolling without slipping: w = v / r, about the right axis.
      spin = Math.hypot(vx, vz) / radius;
    } else {
      const speed = LOB_MIN_SPEED + (LOB_MAX_SPEED - LOB_MIN_SPEED) * charge;
      const pitch = Math.asin(Math.max(-1, Math.min(1, player.frontY)));
      const angle = Math.max(
        0.15,
        Math.min(1.3, (LOB_ANGLE_DEGREES * Math.PI) / 180 + pitch * 0.5),
      );
      x = player.x + fx * 0.6;
      z = player.z + fz * 0.6;
      y = player.y + 0.8;
      vx = fx * Math.cos(angle) * speed + player.vx;
      vy = Math.sin(angle) * speed + Math.max(0, player.vy);
      vz = fz * Math.cos(angle) * speed + player.vz;
      spin = LOB_TUMBLE;
    }

    if (logs?.throwLog(x, y, z, rotation, vx, vy, vz, rightX * spin, 0, rightZ * spin) !== true) {
      // No physics yet: it just falls out of the hand as a pickup.
      dropItem(ItemType.Log, x, y, z, vx, vy, vz);
    }
  };
  /** Lets go of a held snowball along the ground, to roll and pick up snow; a rock or a carton rolls the same. */
  const rollSnowball = (charge: number, held: ItemType | undefined): void => {
    const rolled = rolledItemOf(held);
    const flat = Math.max(1e-3, Math.hypot(player.frontX, player.frontZ));
    const fx = player.frontX / flat;
    const fz = player.frontZ / flat;
    const speed = BOWL_MIN_SPEED + (BOWL_MAX_SPEED - BOWL_MIN_SPEED) * charge;
    const x = player.x + fx * 0.8;
    const z = player.z + fz * 0.8;
    const y = Math.max(player.y, groundAt(x, z)) + (rolled?.radius ?? SNOW_UNIT_RADIUS) + 0.04;
    if (rolled !== undefined) spawnRolled(snowballs, rolled, x, y, z, fx * speed + player.vx, 0, fz * speed + player.vz);
    else snowballs.spawn(x, y, z, fx * speed + player.vx, 0, fz * speed + player.vz);
  };

  /**
   * Puts a held snowball (or rock, carton, can, ball of goo) overhand, from the
   * shoulder along the line of sight.
   */
  const putSnowball = (charge: number, held: ItemType | undefined): void => {
    const rolled = rolledItemOf(held);
    const vessel = vesselOf(held);
    const speed =
      vessel !== undefined ? putSpeedAt(vessel, charge) : PUT_MIN_SPEED + (PUT_MAX_SPEED - PUT_MIN_SPEED) * charge;
    // A touch above the crosshair, as a shot put leaves the hand rising.
    const length = Math.hypot(player.frontX, player.frontY + 0.06, player.frontZ);
    const dx = player.frontX / length;
    const dy = (player.frontY + 0.06) / length;
    const dz = player.frontZ / length;
    const x = player.x + dx * 0.5;
    const y = player.y + player.eyeHeight - 0.15 + dy * 0.5;
    const z = player.z + dz * 0.5;
    if (vessel !== undefined) {
      // It bursts, or lands, as it meets something: see items/vessel.ts.
      vessels.throw(vessel, shake.level, x, y, z, dx * speed + player.vx, dy * speed + player.vy, dz * speed + player.vz);
      shake.reset();
      return;
    }
    if (rolled !== undefined) {
      // A rock is a ball like the rest: it flies, lands, bounces and rolls in the same field.
      spawnRolled(snowballs, rolled, x, y, z, dx * speed + player.vx, dy * speed + player.vy, dz * speed + player.vz);
      return;
    }
    flyingSnow.throw(
      x,
      y,
      z,
      dx * speed + player.vx,
      dy * speed + player.vy,
      dz * speed + player.vz,
    );
  };
  /**
   * What our hands are doing, for both views of us. In multiplayer this is
   * what gets sent (packAvatarPose) and what a remote player's model is
   * drawn from.
   */
  const avatarPose = createAvatarPose();
  let pickupCooldown = 0;
  /** Seconds until the next rattle of a can being shaken. */
  let shakeRattle = 0;
  const prompt = requireElement<HTMLDivElement>("#prompt");
  const nearTrees: Tree[] = [];
  let scoopCooldown = 0;
  /** For {@link handsSpent}: what was held last frame, and in which slot. */
  let lastHeldType: ItemType | undefined;
  let lastHeldSlot = 0;
  /** The held stack ran out mid-press: no scooping or chupping until the buttons are released. */
  let handsSpent = false;
  let scoopAnchored = false;
  let anchorOriginX = 0;
  let anchorOriginY = 0;
  let anchorOriginZ = 0;
  let anchorDirX = 0;
  let anchorDirY = 0;
  let anchorDirZ = 0;
  let anchorCenterX = 0;
  let anchorCenterY = 0;
  let anchorCenterZ = 0;
  /** -1 when the anchored dig is on terrain. */
  let anchorTreeId = -1;
  /** A scoop on a prop does nothing: digging at its centre would hollow the ground beside it. */
  let anchorOnProp = false;
  let anchorPropId = 0;
  let anchorTreePart = TREE_PART_TRUNK;

  if (import.meta.env.DEV) {
    // Dev-only handle for driving the game from the console: aiming at a
    // specific tree by hand to test a chop is slow and unrepeatable.
    (window as unknown as Record<string, unknown>).fgp = {
      world,
      player,
      worldRenderer,
      sceneQuery,
      playerCamera,
      playerModel,
      avatarPose,
      treeRenderer,
      propRenderer,
      pickups,
      snowballs,
      flyingSnow,
      inventory,
      trampolines,
      thrown,
      itemAssets,
      scene,
      camera,
      atmosphere,
      snow,
      terrainMaterial,
      get logs(): LogSystem | undefined {
        return logs;
      },
    };
  }

  void renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const rawDt = now - lastTime;
    lastTime = now;

    stats.sample(rawDt);

    // A collapsed viewport has no valid swapchain to present into. Bail
    // before touching the renderer rather than letting it fail per frame.
    if (!isRenderable()) return;

    // Look is applied once per frame, not per substep: mouse delta is a
    // per-frame quantity and dividing it across substeps would make
    // sensitivity depend on how many substeps the frame happened to run.
    // The map takes the mouse while it is up: no looking, swinging or aiming.
    if (input.wasPressed("Tab")) statsPanel.hidden = !statsPanel.hidden;
    if (input.wasPressed("KeyM")) {
      mapView.open = !mapView.open;
      if (!mapView.open) audio.play("mapClose");
    } else if (mapView.open && input.wasPressed("Escape")) {
      mapView.open = false;
      audio.play("menuBack");
    }
    if (input.wasPressed("KeyI") && !mapView.open) {
      if (inventoryScreen.open) closeInventory();
      else openInventory();
    } else if (inventoryScreen.open && input.wasPressed("Escape")) {
      closeInventory();
    }
    const wheel = input.consumeWheel();
    if (mapView.open) {
      mapView.zoomBy(wheel);
      // WASD pans the map instead of walking (see keysFree below).
      mapView.pan(
        (input.isDown("KeyD") ? 1 : 0) - (input.isDown("KeyA") ? 1 : 0),
        (input.isDown("KeyS") ? 1 : 0) - (input.isDown("KeyW") ? 1 : 0),
        rawDt,
      );
    }
    // The inventory screen takes the mouse and the keys: no looking, moving, swinging or aiming.
    const active = input.locked && !mapView.open && !inventoryScreen.open;

    // What is in the hand, for the placement controls: scroll steps the turn of a placeable and
    // R held turns it freely with the mouse (R is the ragball key otherwise).
    const heldForPlacing = inventory.selectedItem()?.type;
    const placingNow = placementOf(heldForPlacing) !== undefined;
    if (heldForPlacing !== orientedItem) {
      orientedItem = heldForPlacing;
      orientation.reset();
    }
    if (active) {
      if (placingNow && input.isDown("KeyR")) {
        orientation.drag(input.consumeMouseX(), input.consumeMouseY());
      } else {
        player.look(input.consumeMouseX(), input.consumeMouseY());
      }
      if (placingNow && wheel !== 0) {
        orientation.step(Math.sign(wheel) * Math.max(1, Math.round(Math.abs(wheel) / 100)));
      }
    }

    for (let slot = 0; slot < HOTBAR_SLOTS; slot++) {
      if (input.wasPressed(`Digit${String(slot + 1)}`)) inventory.selectSlot(slot);
    }

    if (input.wasPressed("KeyR") && !placingNow) {
      const modeBefore = player.mode;
      player.toggleMode(sceneQuery);
      if (player.mode !== modeBefore) {
        audio.play("ragball", { pitch: player.mode === PlayerMode.Ragball ? 0 : 5 });
      }
    }
    if (input.wasPressed("KeyV")) playerCamera.togglePerspective();
    if (input.wasPressed("Minus")) {
      playerCamera.fovDegrees = Math.max(FOV_MIN, playerCamera.fovDegrees - FOV_STEP);
    }
    if (input.wasPressed("Equal")) {
      playerCamera.fovDegrees = Math.min(FOV_MAX, playerCamera.fovDegrees + FOV_STEP);
    }

    const keysFree = !inventoryScreen.open && !mapView.open;
    playerInput.moveX = keysFree ? (input.isDown("KeyD") ? 1 : 0) - (input.isDown("KeyA") ? 1 : 0) : 0;
    playerInput.moveZ = keysFree ? (input.isDown("KeyW") ? 1 : 0) - (input.isDown("KeyS") ? 1 : 0) : 0;
    // Edge-triggered, then latched for the whole frame: the jump has to
    // survive to whichever substep runs it, but must not fire in more than
    // one of them.
    // On a skateboard the mouse is the buttons: left is the ollie (Space
    // too), right is the trick (a kickflip in the air, a manual held on the
    // ground). Nothing else is bound to them while it is equipped.
    // Still "skating" while down after a bail, though the board is gone from
    // the hotbar by then: the rider's fall plays out on the skate state.
    const boardEquipped = inventory.selectedItem()?.type === ItemType.Skateboard;
    springShoesOn = inventory.selectedItem()?.type === ItemType.SpringShoes;
    player.skating = boardEquipped || player.skate.isDown;
    const skateView = player.skating && player.mode === PlayerMode.Walking;
    if (skateView !== wasSkateView) {
      // A board is ridden in third person, and the view goes back when it is put away.
      wasSkateView = skateView;
      if (skateView) {
        perspectiveBeforeSkate = playerCamera.perspective;
        playerCamera.perspective = CameraPerspective.ThirdPerson;
      } else {
        playerCamera.perspective = perspectiveBeforeSkate;
      }
    }
    const riding = active && player.skating;
    playerInput.jumpPressed = (keysFree && input.wasPressed("Space")) || (riding && input.wasMousePressed(0));
    playerInput.skateTrickPressed = riding && input.wasMousePressed(2);
    playerInput.skateTrickHeld = riding && input.isMouseDown(2);
    if (playerInput.jumpPressed) jumpBuffer = PUMP_BUFFER_SECONDS;

    // Clamp BEFORE accumulating so a long stall -- alt-tab, a GC pause, a
    // breakpoint -- cannot dump a huge backlog of substeps into the next
    // frame.
    accumulator += Math.min(rawDt, MAX_FRAME_TIME);

    if (!spawned && world.hasChunkAt(player.x, player.y, player.z)) {
      spawned = true;
      audio.play("spawn");
    }

    // Standing trunks and stumps near the player are solid. Rebuilt per
    // frame rather than per substep: the player moves centimetres a frame,
    // and the radius has metres of slack.
    sceneQuery.statics.length = 0;
    sceneQuery.boxes.length = 0;
    for (const tree of world.treesNear(player.x, player.z, TRUNK_COLLIDE_RADIUS, nearTrees)) {
      if (tree.trunkTopMeters <= 0) continue;
      const trunk: OrientedBody = {
        radius: tree.trunkRadiusMeters,
        halfHeight: tree.trunkTopMeters / 2,
        x: tree.x,
        y: tree.y + tree.trunkTopMeters / 2,
        z: tree.z,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
      };
      sceneQuery.statics.push(trunk);
    }
    // Trampolines are solid too: stood on, stepped onto, jumped onto.
    trampolines.collectNear(player.x, player.z, TRUNK_COLLIDE_RADIUS, sceneQuery.statics);
    // And so are the snowmen, a ball at a time, and a house, as a box.
    for (const prop of world.propsNear(player.x, player.z, TRUNK_COLLIDE_RADIUS + 1, nearProps)) {
      propBox(prop, sceneQuery.boxes);
      if (PROP_METRICS[prop.kind].breakable !== undefined) continue;
      colliderScratch.length = 0;
      propColliders(prop, colliderScratch);
      for (const part of colliderScratch) {
        sceneQuery.statics.push({
          radius: part.radius,
          halfHeight: (part.y1 - part.y0) / 2,
          x: part.x,
          y: (part.y0 + part.y1) / 2,
          z: part.z,
          qx: 0,
          qy: 0,
          qz: 0,
          qw: 1,
        });
      }
    }
    // Rolling and flying snow gets away from the player, and has to meet the
    // trunks wherever it goes, not only the ones kept solid near the player.
    trunkQuery.trunks.length = 0;
    const gatherTrunks = (x: number, z: number): void => {
      for (const tree of world.treesNear(x, z, SNOW_TRUNK_RADIUS, snowTrees)) {
        if (tree.trunkTopMeters <= 0) continue;
        trunkQuery.trunks.push({
          x: tree.x,
          z: tree.z,
          y0: tree.y,
          y1: tree.y + tree.trunkTopMeters,
          radius: tree.trunkRadiusMeters,
        });
      }
      for (const prop of world.propsNear(x, z, SNOW_TRUNK_RADIUS, nearProps)) {
        propColliders(prop, trunkQuery.trunks);
      }
    };
    // Snowbanks are solid ground, to the player and to snow alike.
    sceneQuery.mounds.clear();
    const gatherMounds = (x: number, z: number, reach: number): void => {
      for (const prop of world.propsNear(x, z, reach, nearProps)) {
        if (prop.kind === "snowbank") sceneQuery.mounds.add(prop.x, prop.y, prop.z, prop.scale, prop.yaw);
      }
    };
    gatherMounds(player.x, player.z, MOUND_GATHER_RADIUS);
    for (const ball of snowballs.balls) {
      if (!ball.rolling || ball.far) continue;
      gatherTrunks(ball.x, ball.z);
      gatherMounds(ball.x, ball.z, MOUND_GATHER_RADIUS);
    }
    for (const ball of flyingSnow.flying) {
      gatherTrunks(ball.x, ball.z);
      gatherMounds(ball.x, ball.z, MOUND_GATHER_RADIUS);
    }
    for (const body of vessels.flying) {
      gatherTrunks(body.x, body.z);
      gatherMounds(body.x, body.z, MOUND_GATHER_RADIUS);
    }

    for (const rope of ropes.ropes) {
      const middle = (rope.nodeCount >> 1) * 3;
      const midX = rope.positions[middle] ?? 0;
      const midZ = rope.positions[middle + 2] ?? 0;
      if (Math.hypot(midX - player.x, midZ - player.z) > ROPE_SIM_RADIUS) continue;
      gatherTrunks(midX, midZ);
      gatherMounds(midX, midZ, MOUND_GATHER_RADIUS);
    }

    let substeps = 0;
    while (spawned && accumulator >= FIXED_TIMESTEP && substeps < MAX_SUBSTEPS) {
      prevX = player.x;
      prevY = player.y;
      prevZ = player.z;
      const wasOnMat = trampolines.isStandingOn(player);
      const preVy = player.vy;
      const wasGrounded = player.grounded;
      const bailsBefore = player.skate.bails;
      player.update(playerInput, FIXED_TIMESTEP, sceneQuery, spawnSurface);
      // Landing on a mat gives back the speed it was landed with; a jump
      // timed with the landing (space held, or pressed just before) adds
      // a little. See items/trampoline.ts.
      const pumping = player.mode === PlayerMode.Walking && (input.isDown("Space") || jumpBuffer > 0);
      const bounced = trampolines.afterPlayerStep(
        player,
        wasOnMat,
        preVy,
        FIXED_TIMESTEP,
        playerInput.jumpPressed,
        pumping,
      );
      // Spring shoes turn the step into a bound, and add to a mat's rebound.
      // See items/springShoes.ts.
      const sprung =
        springShoesOn && player.mode === PlayerMode.Walking && !player.skating
          ? springStride.afterPlayerStep(
              player,
              FIXED_TIMESTEP,
              {
                wasGrounded,
                preVy,
                moving: Math.hypot(playerInput.moveX, playerInput.moveZ) > 0.1,
                jumped: playerInput.jumpPressed,
                pumping,
                matRebound: bounced,
              },
              player.jumpSpeed,
            )
          : 0;
      if (sprung > 0) {
        audio.play("trampolineBounce", { gain: 0.3 * Math.min(1, 0.4 + sprung / 16), pitch: 7, variance: 1 });
      } else if (bounced > 0) {
        audio.play("trampolineBounce", { gain: 0.5 * Math.min(1, 0.4 + bounced / 20) });
      } else if (!wasGrounded && player.grounded) {
        // A bail has its own sound; the landing that caused it is not another.
        const landed = player.skate.bails === bailsBefore ? landingGain(-preVy) : 0;
        if (landed > 0) audio.play("landHard", { gain: landed, variance: 1 });
      } else if (
        wasGrounded &&
        !player.grounded &&
        player.vy > 0 &&
        player.mode === PlayerMode.Walking &&
        !player.skating
      ) {
        audio.play("jump", { gain: 0.6, variance: 1 });
      }
      jumpBuffer = Math.max(0, jumpBuffer - FIXED_TIMESTEP);
      // Bodies step on the same fixed clock as the player, so a falling log
      // behaves identically whatever the display rate is.
      physics?.step(FIXED_TIMESTEP);
      // Consumed: a single keypress is one impulse, not one per substep.
      playerInput.jumpPressed = false;
      playerInput.skateTrickPressed = false;
      for (const board of looseBoards) board.update(FIXED_TIMESTEP, sceneQuery);
      // Walking into a snowball shoves it; the ragball is a sphere, its y at the bottom.
      const ragball = player.mode === PlayerMode.Ragball;
      const bodyRadius = ragball ? player.ballRadius : WALK_HALF_WIDTH;
      const bodyHeight = ragball ? player.ballRadius * 2 : WALK_HEIGHT;
      snowballs.pushedBy(player.x, player.y, player.z, player.vx, player.vz, bodyRadius, bodyHeight, PLAYER_MASS);
      // Something heavy shoved pushes back on whoever shoved it.
      if (snowballs.reaction.x !== 0 || snowballs.reaction.z !== 0) {
        player.applyImpulse(snowballs.reaction.x, 0, snowballs.reaction.z);
      }
      // Snowmen are hit by a ball that meets one at speed: a rock thrown at it,
      // a snowball rolled hard. Checked before the step, which bounces it off.
      ballHitClock += FIXED_TIMESTEP;
      for (const ball of snowballs.balls) {
        if (!ball.rolling || ball.far) continue;
        if (Math.hypot(ball.vx, ball.vy, ball.vz) < HIT_SPEED) continue;
        if ((ballHitAt.get(ball) ?? 0) > ballHitClock) continue;
        for (const prop of world.propsNear(ball.x, ball.z, ball.radius + 3, nearProps)) {
          if (sectionTouching(prop, ball.x, ball.y, ball.z, ball.radius) < 0) continue;
          ballHitAt.set(ball, ballHitClock + BALL_HIT_COOLDOWN);
          const made = itemOfBall(ball);
          hurtProp(prop.id, ball.x, ball.y, ball.z, made === ItemType.Rock ? "rock" : made === ItemType.Eggnog ? "eggnog" : "snowball");
          break;
        }
      }
      snowballs.step(FIXED_TIMESTEP, trunkQuery, snowAt);
      // One that could not move for them is not walked through.
      snowballs.yieldTo(player.x, player.y, player.z, bodyRadius, bodyHeight, snowYield);
      player.x += snowYield.x;
      player.z += snowYield.z;
      flyingSnow.step(FIXED_TIMESTEP, trunkQuery);
      vessels.step(FIXED_TIMESTEP, trunkQuery);
      ropes.step(FIXED_TIMESTEP, trunkQuery, player.x, player.z, ROPE_SIM_RADIUS, elasticColliders);
      accumulator -= FIXED_TIMESTEP;
      substeps++;
    }
    if (player.skate.ollies !== seenOllies) {
      seenOllies = player.skate.ollies;
      audio.play("ollie", { variance: 0.5 });
    }
    if (player.skate.flips !== seenFlips) {
      seenFlips = player.skate.flips;
      audio.play("kickflip", { variance: 0.5 });
    }
    if (player.skate.flipsLanded !== seenFlipsLanded) {
      seenFlipsLanded = player.skate.flipsLanded;
      audio.play("orchestraHit", { chord: ORCHESTRA_HIT_CHORD });
      trickBanner.show();
    }
    if (player.skate.pushes !== seenPushes) {
      seenPushes = player.skate.pushes;
      audio.play("skatePush", { gain: 0.35, variance: 1 });
    }
    if (player.skate.bails !== seenBails) {
      seenBails = player.skate.bails;
      audio.play("hit3");
      trickBanner.hide();
    }
    // Off the board (hopped off, or it was swapped away): no trick graphic.
    if (!player.skating) trickBanner.hide();
    if (player.respawns !== seenRespawns) {
      seenRespawns = player.respawns;
      audio.play("spawn");
    }
    // A foot comes down every STRIDE_METERS walked on the ground.
    const walkedSpeed =
      spawned && player.mode === PlayerMode.Walking && player.grounded && !player.skating
        ? Math.hypot(player.vx, player.vz)
        : 0;
    if (stride.update(rawDt, walkedSpeed)) {
      audio.play("footstep", { gain: 0.6, pitch: stride.foot === 0 ? -1 : 1, variance: 1.5 });
    }
    // A tied string pulled hard by what it is tied to twangs once.
    for (const rope of ropes.ropes) {
      const pull = Math.max(rope.tension[0], rope.tension[1]) / rope.spec.maxForce;
      if (!twangs.update(rope, pull)) continue;
      const middle = (rope.nodeCount >> 1) * 3;
      const heard = hearing(
        rope.positions[middle] ?? 0,
        rope.positions[middle + 1] ?? 0,
        rope.positions[middle + 2] ?? 0,
      );
      audio.play("xmasTension", { gain: heard * Math.min(1, pull) });
    }

    // A bail throws the board from under the rider, out of the hotbar and
    // into the world, with the speed it had.
    const ejected = player.skate.ejected;
    if (ejected !== undefined) {
      player.skate.ejected = undefined;
      if (boardEquipped) {
        inventory.tryConsumeSelected();
        // Back to bare hands (hotbar 1) rather than an empty slot.
        inventory.selectSlot(0);
      }
      looseBoards.push(new LooseBoard(ejected));
    }
    for (let i = looseBoards.length - 1; i >= 0; i--) {
      const board = looseBoards[i];
      if (board === undefined) continue;
      // Run into one while it is still rolling, once you are back on your
      // feet, and you hop straight back on: no waiting for it to stop and E.
      const touching =
        active &&
        spawned &&
        !boardEquipped &&
        player.mode === PlayerMode.Walking &&
        !player.skate.isDown &&
        Math.hypot(board.x - player.x, board.z - player.z) < player.halfWidth + 0.45 &&
        board.y > player.y - 0.4 &&
        board.y < player.y + 1.7;
      if (touching && inventory.tryAdd(ItemType.Skateboard)) {
        audio.play("pickupAlt", { variance: 1 });
        looseBoards.splice(i, 1);
        for (let slot = 1; slot < HOTBAR_SLOTS; slot++) {
          if (inventory.slot(slot)?.type === ItemType.Skateboard) {
            inventory.selectSlot(slot);
            break;
          }
        }
      }
    }
    // One that has stopped turns into something to pick up, lying where it stopped.
    for (let i = looseBoards.length - 1; i >= 0; i--) {
      const board = looseBoards[i];
      if (board === undefined || !board.settled) continue;
      looseBoards.splice(i, 1);
      const groundY = board.resting ? board.y : groundAt(board.x, board.z);
      pickups.spawn(
        ItemType.Skateboard,
        board.x,
        groundY + 0.3,
        board.z,
        groundY,
        performance.now() / 1000,
      );
    }
    // A bit inside the loaded area, so a rock never counts as unsupported for want of loaded ground.
    snowballs.tick(rawDt, player.x, player.z, (radius - 1) * CHUNK_METERS);
    for (const burst of flyingSnow.bursts) {
      for (const prop of world.propsNear(burst.x, burst.z, 3, nearProps)) {
        if (sectionTouching(prop, burst.x, burst.y, burst.z, 0.1) >= 0) {
          hurtProp(prop.id, burst.x, burst.y, burst.z, "snowball");
          break;
        }
      }
      snowPuffs.burst(burst.x, burst.y, burst.z, burst.nx, burst.ny, burst.nz);
      audio.play("hit2", { gain: hearing(burst.x, burst.y, burst.z), variance: 2 });
    }
    flyingSnow.bursts.length = 0;
    for (const splat of vessels.splats) burstVessel(splat);
    vessels.splats.length = 0;
    for (const landing of vessels.landings) {
      dropItem(landing.item, landing.x, landing.y, landing.z, landing.vx, landing.vy, landing.vz);
      audio.play("itemDrop", { gain: 0.8 * hearing(landing.x, landing.y, landing.z), variance: 2 });
    }
    vessels.landings.length = 0;
    snowPuffs.update(rawDt);
    gooSpray.update(camera, rawDt, terrainAt);
    gooStains.update(rawDt);
    if (!spawned) accumulator = 0;
    if (substeps === MAX_SUBSTEPS) {
      // Time is deliberately dropped rather than carried, so a slow frame
      // cannot spiral into progressively slower ones.
      accumulator = 0;
    }

    const alpha = accumulator / FIXED_TIMESTEP;
    const renderX = prevX + (player.x - prevX) * alpha;
    const renderY = prevY + (player.y - prevY) * alpha;
    const renderZ = prevZ + (player.z - prevZ) * alpha;

    world.update(player.x, player.z, worldRenderer);

    // Explore around the player. Entering a new chunk column (or opening the
    // map) redraws everything in range so edits show; in between, a slow sweep
    // only fills in columns that had not finished streaming.
    if (spawned) {
      const chunkX = Math.floor(player.x / CHUNK_METERS);
      const chunkZ = Math.floor(player.z / CHUNK_METERS);
      const justOpened = mapView.open && !mapWasOpen;
      if (chunkX !== mapChunkX || chunkZ !== mapChunkZ || justOpened) {
        mapChunkX = chunkX;
        mapChunkZ = chunkZ;
        mapSweepAt = now + MAP_SWEEP_SECONDS;
        mapData.explore(player.x, player.z, mapRadius, true);
      } else if (now >= mapSweepAt) {
        mapSweepAt = now + MAP_SWEEP_SECONDS;
        mapData.explore(player.x, player.z, mapRadius, false);
      }
      mapData.refresh(world, MAP_BUDGET_MS);
    }
    mapWasOpen = mapView.open;
    // Every frame, not only on boundary crossings -- otherwise finished
    // chunks sit in the queue until the player happens to move again.
    const drainMs = world.drain(worldRenderer);
    if (drainMs > worstDrainMs) worstDrainMs = drainMs;

    // --- scoop ---------------------------------------------------------
    const eyeX = player.x;
    const eyeY = player.y + player.eyeHeight;
    const eyeZ = player.z;

    world.raycastScene(
      eyeX,
      eyeY,
      eyeZ,
      player.frontX,
      player.frontY,
      player.frontZ,
      SCOOP_REACH_METERS,
      hit,
    );
    // Placed building pieces, for aiming a placement at them and for picking them up.
    buildField.raycast(
      eyeX,
      eyeY,
      eyeZ,
      player.frontX,
      player.frontY,
      player.frontZ,
      SCOOP_REACH_METERS,
      buildHit,
    );
    logs?.raycast(
      eyeX,
      eyeY,
      eyeZ,
      player.frontX,
      player.frontY,
      player.frontZ,
      hit.kind === HitKind.None ? SCOOP_REACH_METERS : hit.distance,
      pieceHit,
    );
    // A felled piece in front of whatever the scene ray found is what the
    // crosshair is on.
    const onPiece = logs !== undefined && pieceHit.piece !== undefined;
    // A rolled snowball in front of whatever the scene ray found, and of any
    // felled piece, is what the crosshair is on.
    snowballs.raycast(
      eyeX,
      eyeY,
      eyeZ,
      player.frontX,
      player.frontY,
      player.frontZ,
      onPiece ? pieceHit.distance : hit.kind === HitKind.None ? SCOOP_REACH_METERS : hit.distance,
      snowballHit,
    );
    const onBall = snowballHit.ball !== undefined;
    const aimed = hit.kind !== HitKind.None && !onPiece && !onBall;
    const heldType = inventory.selectedItem()?.type;

    // An empty hotbar slot has bare hands, like slot 1. But when the last of an
    // item is used up with a button still down (the last trampoline placed with
    // the left one), that same press must not start digging: wait for release.
    if (heldType === undefined && lastHeldType !== undefined && inventory.selectedSlot === lastHeldSlot) {
      handsSpent = true;
    }
    if (!input.isMouseDown(0) && !input.isMouseDown(2)) handsSpent = false;
    lastHeldType = heldType;
    lastHeldSlot = inventory.selectedSlot;
    const handsFree = inventory.isUnarmedSelected && !handsSpent;

    // Walking only: there is no hand free to swing while tucked into a ball.
    // Scoop and chup are the Unarmed slot's actions: holding an item means
    // your hands are full. It is the whole of the tool system for now, and
    // the natural place future tools hook in.
    const canScoop =
      active &&
      player.mode === PlayerMode.Walking &&
      handsFree &&
      input.isMouseDown(0);

    if (canScoop) {
      scoopCooldown -= rawDt;
      if (scoopCooldown <= 0 && snowballHit.ball !== undefined) {
        hitSnowball(snowballHit.ball);
        scoopAnchored = false;
        scoopCooldown = SCOOP_TICK_SECONDS;
      } else if (scoopCooldown <= 0) {
        const sameAnchor =
          scoopAnchored &&
          Math.hypot(eyeX - anchorOriginX, eyeY - anchorOriginY, eyeZ - anchorOriginZ) <=
            SCOOP_REANCHOR_POSITION &&
          player.frontX * anchorDirX + player.frontY * anchorDirY + player.frontZ * anchorDirZ >=
            SCOOP_REANCHOR_DIRECTION;

        if (!sameAnchor) {
          if (aimed) {
            scoopAnchored = true;
            anchorOriginX = eyeX;
            anchorOriginY = eyeY;
            anchorOriginZ = eyeZ;
            anchorDirX = player.frontX;
            anchorDirY = player.frontY;
            anchorDirZ = player.frontZ;
            anchorCenterX = hit.centerX;
            anchorCenterY = hit.centerY;
            anchorCenterZ = hit.centerZ;
            anchorTreeId = hit.kind === HitKind.Tree ? hit.treeId : -1;
            anchorOnProp = hit.kind === HitKind.Prop;
            anchorPropId = hit.propId;
            anchorTreePart = hit.treePart;
          } else {
            scoopAnchored = false;
          }
        }

        if (scoopAnchored && !anchorOnProp && !onPiece) {
          if (anchorTreeId >= 0) {
            // A scoop anywhere on the tree shakes its xmas lights loose.
            const shaken = world.knockLights(anchorTreeId, worldRenderer);
            if (shaken > 0) {
              scatterLights(anchorCenterX, anchorCenterY, anchorCenterZ, shaken);
              audio.play("lightsShake", { variance: 2 });
            }
            // Foliage only: a trunk is chup-only, as it was when leaves
            // were scoopable voxels and wood was not.
            const puffed =
              anchorTreePart !== TREE_PART_TRUNK &&
              world.stripFoliage(anchorTreeId, anchorTreePart, worldRenderer);
            if (puffed) {
              audio.play("leafPuff", { variance: 2 });
              for (let leaf = 0; leaf < LEAF_PUFF_COUNT; leaf++) {
                dropItem(
                  ItemType.Leaf,
                  anchorCenterX + (Math.random() - 0.5) * LEAF_PUFF_SPREAD,
                  anchorCenterY + (Math.random() - 0.5) * LEAF_PUFF_SPREAD,
                  anchorCenterZ + (Math.random() - 0.5) * LEAF_PUFF_SPREAD,
                );
              }
            }
          }
          // Scooping bare ground does nothing: there is no digging in this game.
        } else if (scoopAnchored && anchorOnProp && !onPiece) {
          // A scoop does nothing to a prop -- except a snowbank, which is there
          // to be scooped.
          const kind = world.getProp(anchorPropId)?.kind;
          if (kind !== undefined && (PROP_METRICS[kind].scoopable === true || isBreakable(kind))) {
            harvestPropAt(anchorPropId, anchorCenterX, anchorCenterY, anchorCenterZ, "scoop");
          }
        }
        scoopCooldown = SCOOP_TICK_SECONDS;
      }
    } else {
      // Clamped at zero rather than left to run negative, so a
      // release-then-repress cannot fire a queued burst. Releasing also
      // drops the anchor: the next press always starts a fresh gesture.
      scoopCooldown = 0;
      scoopAnchored = false;
    }

    // Chup is right mouse, and unlike the scoop it re-raycasts every tick:
    // the cut is a thin shear that has to follow the trunk as it is eaten
    // away, so anchoring it would make repeat swings miss. A stick swung
    // like a sword (left mouse) is a chup too, and does everything one does.
    const walking = active && player.mode === PlayerMode.Walking;
    const holdingStick = heldType === ItemType.Stick;
    const canChup =
      walking &&
      ((handsFree && input.isMouseDown(2)) ||
        (holdingStick && input.isMouseDown(0) && throwCharge === 0));
    if (canChup) {
      chupCooldown -= rawDt;
      if (chupCooldown <= 0) {
        if (onPiece && pieceHit.piece !== undefined) {
          if (logs?.chup(pieceHit.piece, pieceHit.x, pieceHit.y, pieceHit.z) === true) {
            audio.play("chopHit", { variance: 2 });
            splashSticks(pieceHit.x, pieceHit.y, pieceHit.z);
          }
        } else if (snowballHit.ball !== undefined) {
          hitSnowball(snowballHit.ball);
        } else if (hit.kind === HitKind.Prop) {
          // Resources come out of props the way sticks come off trees: a
          // swing that lands has a chance of knocking one loose. What and
          // how often is the generation sheet's call, not ours.
          harvestPropAt(hit.propId, hit.centerX, hit.centerY, hit.centerZ, "chup");
        } else if (hit.kind === HitKind.Tree) {
          // The swing lands on the trunk at the height you are looking at,
          // whether the crosshair found trunk or canopy. A tree is mostly
          // canopy, so demanding a hit on the pole inside it reads as
          // "chopping does not work".
          const tree = world.getTree(hit.treeId);
          const chopX = tree?.x ?? hit.centerX;
          const chopZ = tree?.z ?? hit.centerZ;
          const chop = world.chopTree(hit.treeId, hit.centerY, worldRenderer);
          if (chop.felled) buildSystem.disturb(chopX, hit.centerY, chopZ, (tree?.trunkRadiusMeters ?? 0.5) + 1);
          if (chop.landed) {
            audio.play("chopHit", { variance: 2 });
            if (chop.felled) audio.play("treeBreak");
            // Out of the bark on the swinger's side, not the trunk's middle.
            const radius = tree?.trunkRadiusMeters ?? 0;
            const sideX = eyeX - chopX;
            const sideZ = eyeZ - chopZ;
            const side = Math.max(1e-3, Math.hypot(sideX, sideZ));
            const barkX = chopX + (sideX / side) * radius;
            const barkZ = chopZ + (sideZ / side) * radius;
            splashSticks(barkX, hit.centerY, barkZ);
            if (chop.lightsDropped > 0) {
              // Whatever was strung on it falls to the swinger's side.
              scatterLights(barkX, hit.centerY, barkZ, chop.lightsDropped);
            }
          }
        } else {
          audio.play("whiff", { variance: 1.5 });
        }
        chupCooldown = CHUP_TICK_SECONDS;
      }
    } else {
      chupCooldown = 0;
    }

    // --- throws: hold to charge, release to let go ---
    // A stick is a spear on right mouse; a log bowls on left and lobs on
    // right. Which one is decided when the button goes down and kept until
    // it comes up.
    const holdingLog = heldType === ItemType.Log;
    // A rock or a carton of eggnog is used exactly as a snowball is.
    const holdingSnowball = heldType === ItemType.Snowball || rolledItemOf(heldType) !== undefined;
    // A can or a ball of goo is shaken with left mouse and put with right.
    const holdingVessel = vesselOf(heldType) !== undefined;
    // A snowball is rolled like a log, and put overhand rather than lobbed.
    const holdsForThrow =
      throwKind === AvatarAction.Charge
        ? holdingStick
        : throwKind === AvatarAction.Put
          ? holdingSnowball || holdingVessel
          : throwKind === AvatarAction.Bowl
            ? holdingLog || holdingSnowball
            : holdingLog;
    if (throwCharge > 0 && (inventory.selectedSlot !== throwSlot || !walking || !holdsForThrow)) {
      // Switching away mid-charge, or tucking into a ball, cancels it.
      throwCharge = 0;
    }
    if (throwCharge === 0 && walking) {
      if (holdingStick && input.isMouseDown(2)) {
        throwKind = AvatarAction.Charge;
        throwButton = 2;
      } else if ((holdingSnowball || holdingVessel) && input.isMouseDown(2)) {
        throwKind = AvatarAction.Put;
        throwButton = 2;
      } else if ((holdingLog || holdingSnowball) && input.isMouseDown(0)) {
        throwKind = AvatarAction.Bowl;
        throwButton = 0;
      } else if (holdingLog && input.isMouseDown(2)) {
        throwKind = AvatarAction.Lob;
        throwButton = 2;
      } else {
        throwButton = -1;
      }
    }
    let threw = false;
    tapPlace = false;
    if (walking && throwButton >= 0 && input.isMouseDown(throwButton)) {
      if (throwCharge === 0) throwSlot = inventory.selectedSlot;
      // Never exactly zero once started, so a click shorter than a frame
      // still throws (weakly) on release.
      throwCharge = Math.max(1e-3, Math.min(1, throwCharge + rawDt / THROW_CHARGE_SECONDS));
    } else if (throwCharge > 0 && throwKind !== AvatarAction.Charge) {
      if (holdingLog && throwKind === AvatarAction.Bowl && throwCharge < TAP_PLACE_CHARGE) {
        // A tap, not a throw: the log is placed (below) instead of bowled.
        tapPlace = true;
      } else if (inventory.tryConsumeSelected()) {
        if (throwKind === AvatarAction.Put) putSnowball(throwCharge, heldType);
        else if (holdingSnowball) rollSnowball(throwCharge, heldType);
        else throwLog(throwKind === AvatarAction.Bowl, throwCharge);
        threw = true;
      }
      throwCharge = 0;
      throwButton = -1;
    } else if (throwCharge > 0) {
      throwButton = -1;
      if (inventory.tryConsumeSelected()) {
        const speed = THROW_MIN_SPEED + (THROW_MAX_SPEED - THROW_MIN_SPEED) * throwCharge;
        const flat = Math.max(1e-3, Math.hypot(player.frontX, player.frontZ));
        const rightX = -player.frontZ / flat;
        const rightZ = player.frontX / flat;
        thrown.throw(
          eyeX,
          eyeY,
          eyeZ,
          eyeX + player.frontX * 0.9 + rightX * 0.12,
          eyeY + player.frontY * 0.9 - 0.05,
          eyeZ + player.frontZ * 0.9 + rightZ * 0.12,
          player.frontX * speed + player.vx,
          player.frontY * speed + player.vy,
          player.frontZ * speed + player.vz,
          logs,
          now,
        );
        threw = true;
      }
      throwCharge = 0;
    }
    thrown.update(rawDt, logs, now);

    // --- shaking: left mouse with a can or a ball of goo, until it is thrown ---
    const shaking = walking && holdingVessel && throwCharge === 0 && input.isMouseDown(0);
    if (!holdingVessel) shake.reset();
    shake.update(rawDt, shaking);
    shakeRattle -= rawDt;
    if (shaking && shakeRattle <= 0) {
      shakeRattle = SHAKE_CYCLE_SECONDS;
      audio.play("stickTick", { gain: 0.25 + 0.2 * shake.level, pitch: 14 + 6 * shake.level, variance: 3 });
    }

    pickups.update(rawDt, now, groundAt, trampolines.restitutionAt.bind(trampolines));

    // --- fishing rod: left mouse casts (hold to throw farther), right mouse reels in ---
    // The sim lives in items/fishing.ts, with the rod's settings. The line leaves from the tip as it
    // was drawn last frame, or from a guess in front of the eye until the rod has been on show.
    const holdingRod = heldType === ItemType.FishingRod;
    fishingFrame.tipX = rodTipSeen ? rodTip.x : eyeX + player.frontX * 1.2;
    fishingFrame.tipY = rodTipSeen ? rodTip.y : eyeY + 0.3 + player.frontY * 1.2;
    fishingFrame.tipZ = rodTipSeen ? rodTip.z : eyeZ + player.frontZ * 1.2;
    fishingFrame.playerX = player.x;
    fishingFrame.playerY = player.y;
    fishingFrame.playerZ = player.z;
    fishingFrame.frontX = player.frontX;
    fishingFrame.frontY = player.frontY;
    fishingFrame.frontZ = player.frontZ;
    fishingInput.active = walking && holdingRod;
    fishingInput.cast = input.isMouseDown(0);
    fishingInput.reel = input.isMouseDown(2);
    const fishingEvents = fishing.update(rawDt, fishingInput, fishingFrame, groundAt, pickups, inventory);
    if (fishingEvents.cast) audio.play("whiff", { pitch: -3, gain: 0.8, variance: 1 });
    if (fishingEvents.landed) audio.play("itemDrop", { variance: 1 });
    if (fishingEvents.hooked) audio.play("ropeTie", { pitch: 7 });
    if (fishingEvents.caught) audio.play("pickupAlt", { variance: 1 });
    else if (fishingEvents.full) audio.play("craftError", { gain: 0.7 });

    // --- placing: a see-through copy of the held item stands where left mouse
    // would put it, green if it can go there and red if not ---
    const placement = placementOf(heldType);
    let plan: PlacementPlan | undefined;
    if (walking && heldType !== undefined && placement !== undefined) {
      if (placement.piece !== undefined) {
        // A building piece goes against whatever surface is aimed at, at any angle.
        aimAtSurface(
          world,
          hit,
          buildHit,
          eyeX,
          eyeY,
          eyeZ,
          player.frontX,
          player.frontY,
          player.frontZ,
          surfaceAim,
        );
        if (surfaceAim.valid) {
          plan = piecePlanner.plan(placement.piece, surfaceAim, player, player.frontX, player.frontZ, orientation);
        }
      } else if (hit.kind !== HitKind.None && !onPiece) {
        plan = planner.plan(
          placement,
          eyeX + player.frontX * hit.distance,
          eyeZ + player.frontZ * hit.distance,
          player,
          orientation.spin,
        );
      }
    }
    if (plan !== undefined && heldType !== undefined) placementPreview.show(heldType, plan);
    else placementPreview.hide();
    hud.set("PLACE", plan === undefined ? "--" : plan.valid ? "ok" : plan.block);
    // A log is also bowled with the left button, so it is placed with a quick tap of it.
    const placeClick = heldType === ItemType.Log ? tapPlace : input.wasMousePressed(0);
    if (plan !== undefined && heldType !== undefined && placeClick) {
      if (!plan.valid || !placeHeld(heldType, plan)) audio.play("craftError", { gain: 0.7 });
    }

    // --- xmas lights: left mouse ties one end, then the other ---
    // Like a tool gun: the end goes on whatever the crosshair is on, which
    // can be a thing that moves (a rolled snowball, a felled piece), and the
    // string is spent once both ends are tied. Players will be tie points too.
    const holdingLights = heldType === ItemType.XmasLights;
    if (!holdingLights || !walking) ropeFirst = undefined;
    const lightsHeld = holdingLights ? (inventory.selectedItem()?.count ?? 0) : 0;
    // E, with one end tied, lets go of it instead of picking anything up.
    let ropeCancelled = false;
    if (ropeFirst !== undefined && input.wasPressed("KeyE")) {
      ropeFirst = undefined;
      ropeCancelled = true;
      pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
      audio.play("pickup", { gain: 0.5 });
    }
    if (ropeFirst?.body !== undefined) {
      // Follows whatever it is tied to; gone, and the string goes back to unstarted.
      if (ropeFirst.body.tiePoint(ropeScratch)) {
        ropeFirst.x = ropeScratch.x;
        ropeFirst.y = ropeScratch.y;
        ropeFirst.z = ropeScratch.z;
      } else {
        ropeFirst = undefined;
      }
    }
    if (ropeLive !== undefined && ropeFirst !== undefined) {
      // Evicted by newer strings, or stretched out of all reason (a respawn): let go.
      handBody.tiePoint(handScratch);
      const gap = Math.hypot(handScratch.x - ropeFirst.x, handScratch.y - ropeFirst.y, handScratch.z - ropeFirst.z);
      if (!ropes.ropes.includes(ropeLive) || gap > ropeLive.length * ROPE_SNAP_RATIO) {
        ropeFirst = undefined;
        audio.play("craftError", { gain: 0.7 });
      }
    }
    if (ropeFirst === undefined) ropeStrings = 1;
    let ropeAimed = false;
    let ropeDistance = -1;
    let ropeX = 0;
    let ropeY = 0;
    let ropeZ = 0;
    if (holdingLights && walking) {
      // Nearest of what the ray found: the balls and pieces were only
      // searched in front of what was found before them.
      ropeDistance = onBall
        ? snowballHit.distance
        : onPiece
          ? pieceHit.distance
          : hit.kind !== HitKind.None
            ? hit.distance
            : -1;
      // A placed building piece nearer than all of that is what the string goes on.
      const onBuilt =
        buildHit.piece !== undefined && (ropeDistance < 0 || buildHit.distance < ropeDistance);
      if (onBuilt) ropeDistance = buildHit.distance;
      const tieBody = (): RopeBody | undefined => {
        if (onBuilt && buildHit.piece !== undefined) {
          return new BuildPieceRopeBody(buildSystem, buildField, buildHit.piece, ropeX, ropeY, ropeZ);
        }
        if (onBall && snowballHit.ball !== undefined) {
          return new BallRopeBody(snowballHit.ball, ropeX, ropeY, ropeZ);
        }
        if (onPiece && pieceHit.piece !== undefined && physics !== undefined) {
          return new PieceRopeBody(physics, pieceHit.piece, ropeX, ropeY, ropeZ);
        }
        return undefined;
      };
      if (ropeDistance >= 0) {
        ropeAimed = true;
        const back = onBall || onPiece || onBuilt ? 0 : ROPE_TIE_STANDOFF;
        ropeX = eyeX + player.frontX * (ropeDistance - back);
        ropeY = eyeY + player.frontY * (ropeDistance - back);
        ropeZ = eyeZ + player.frontZ * (ropeDistance - back);
      }

      // With one end tied, the other is in the hand (the live rope), and the
      // second tie goes on whatever is aimed at, if the string reaches that far.
      const chainSpec = ropeSpecFor(XMAS_LIGHTS, ropeStrings);
      let ropeSpan = 0;
      let onSurface = false;
      if (ropeFirst !== undefined && ropeAimed) {
        ropeSpan = Math.hypot(ropeX - ropeFirst.x, ropeY - ropeFirst.y, ropeZ - ropeFirst.z);
        onSurface = ropeSpan <= ropeMaxReach(chainSpec);
      }

      const tieLeft = input.wasMousePressed(0);
      const tieRight = input.wasMousePressed(2);
      if (tieRight && ropeFirst !== undefined) {
        // Run another string on, to reach further. Nothing is tied by this.
        if (lightsHeld > ropeStrings && ropeStrings < ROPE_MAX_STRINGS) {
          ropeStrings++;
          runLiveRope();
          audio.play("ropeTie", { variance: 0.5, pitch: 3 });
        } else {
          audio.play("craftError", { gain: 0.7 });
        }
      } else if (tieLeft && ropeFirst === undefined && ropeAimed) {
        ropeFirst = { x: ropeX, y: ropeY, z: ropeZ, body: tieBody() };
        ropeStrings = 1;
        runLiveRope();
        audio.play("ropeTie", { variance: 0.5 });
      } else if (tieLeft && ropeFirst !== undefined) {
        if (onSurface) {
          const tie: RopeTie = { x: ropeX, y: ropeY, z: ropeZ, body: tieBody() };
          ropes.add(chainSpec, ropeFirst, tie, planRope(chainSpec, ropeSpan).length);
          inventory.tryConsumeSelected(ropeStrings);
          ropeFirst = undefined;
          ropeStrings = 1;
          audio.play("ropeTie", { pitch: 5 });
        } else {
          // In the air, or out of reach: nothing to tie to.
          audio.play("craftError", { gain: 0.7 });
        }
      }
    }
    // Nothing tied (cancelled, put away, done): no rope in the hand.
    if (ropeFirst === undefined && ropeLive !== undefined) {
      ropes.remove(ropeLive);
      ropeLive = undefined;
    }
    ropesView.sync(ropes);
    ropesView.publishLights(eyeX, eyeY, eyeZ, () => {
      treeLights.offerLights();
      fishingView.offerLights();
    });

    // --- pick up: E, on whatever is under the crosshair or at your feet ---
    const target: Pickup | undefined = active
      ? pickups.target(
          eyeX,
          eyeY,
          eyeZ,
          player.frontX,
          player.frontY,
          player.frontZ,
          player.x,
          player.y,
          player.z,
        )
      : undefined;
    // A placed trampoline is picked up the same way, when nothing smaller is in reach.
    const matTarget: Trampoline | undefined =
      active && target === undefined
        ? trampolines.target(
            eyeX,
            eyeY,
            eyeZ,
            player.frontX,
            player.frontY,
            player.frontZ,
            TRAMPOLINE_PICKUP_REACH,
          )
        : undefined;
    // ...and so is a rock lying about, when it is the thing under the crosshair.
    const rockTarget: Snowball | undefined =
      active &&
      target === undefined &&
      matTarget === undefined &&
      snowballHit.ball !== undefined &&
      itemOfBall(snowballHit.ball) !== undefined &&
      snowballHit.distance <= PICKUP_REACH
        ? snowballHit.ball
        : undefined;
    // ...and so is a placed building piece (a ladder, a plank), when it is the thing under the crosshair.
    const pieceTarget =
      active &&
      target === undefined &&
      matTarget === undefined &&
      rockTarget === undefined &&
      buildHit.piece !== undefined &&
      buildHit.distance <= PICKUP_REACH + 0.9 &&
      (hit.kind === HitKind.None || buildHit.distance <= hit.distance)
        ? buildHit.piece
        : undefined;
    // ...and so is a tied string of xmas lights, when nothing else is nearer.
    let ropeTarget: Rope | undefined;
    if (
      active &&
      target === undefined &&
      matTarget === undefined &&
      rockTarget === undefined &&
      pieceTarget === undefined &&
      ropeFirst === undefined
    ) {
      const reach =
        hit.kind !== HitKind.None ? Math.min(ROPE_PICKUP_REACH, hit.distance + 0.1) : ROPE_PICKUP_REACH;
      ropeTarget = ropes.raycast(
        eyeX,
        eyeY,
        eyeZ,
        player.frontX,
        player.frontY,
        player.frontZ,
        reach,
        ropeHit,
      );
    }
    // ...and so is a container under the crosshair, in the same reach as an item.
    const aimedProp =
      hit.kind === HitKind.Prop && !onPiece && !onBall ? world.getProp(hit.propId) : undefined;
    const containerTarget: Prop | undefined =
      active &&
      target === undefined &&
      matTarget === undefined &&
      rockTarget === undefined &&
      ropeTarget === undefined &&
      ropeFirst === undefined &&
      aimedProp !== undefined &&
      isContainerKind(aimedProp.kind) &&
      hit.distance <= PICKUP_REACH + aimedProp.radius
        ? aimedProp
        : undefined;
    const containerEmpty = containerTarget === undefined || containers.isEmpty(containerTarget);
    pickupCooldown -= rawDt;
    if (
      !ropeCancelled &&
      (input.wasPressed("KeyE") || (input.isDown("KeyE") && pickupCooldown <= 0))
    ) {
      if (target !== undefined) {
        if (pickups.collect(target, inventory)) {
          const raw =
            target.type === ItemType.Stick ||
            target.type === ItemType.Leaf ||
            target.type === ItemType.Log ||
            target.type === ItemType.Snowball;
          audio.play(raw ? "pickup" : "pickupAlt", {
            gain: target.type === ItemType.Leaf ? 0.6 : 1,
            variance: 1,
          });
          pickupCooldown = PICKUP_REPEAT_SECONDS;
        } else {
          // Nowhere to put it.
          audio.play("craftError", { gain: 0.7 });
          pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
        }
      } else if (matTarget !== undefined && inventory.tryAdd(ItemType.Trampoline)) {
        audio.play("pickupAlt", { variance: 1 });
        trampolines.remove(matTarget);
        // Whatever was resting on the mat falls to the ground.
        pickups.dropNear(matTarget.x, matTarget.z, TRAMPOLINE_RADIUS);
        pickupCooldown = PICKUP_REPEAT_SECONDS;
      } else if (rockTarget !== undefined) {
        if (inventory.tryAdd(itemOfBall(rockTarget) ?? ItemType.Rock)) {
          // Ropes tied to it let go of it; it is in your pocket now.
          rockTarget.vanish();
          audio.play("pickup", { variance: 1 });
          pickupCooldown = PICKUP_REPEAT_SECONDS;
        } else {
          audio.play("craftError", { gain: 0.7 });
          pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
        }
      } else if (pieceTarget !== undefined) {
        if (inventory.tryAdd(pieceTarget.spec.item)) {
          buildField.remove(pieceTarget);
          // Whatever was resting on it settles again.
          buildSystem.disturb(pieceTarget.x, pieceTarget.y, pieceTarget.z, pieceTarget.solid.reach);
          audio.play("pickupAlt", { variance: 1 });
          pickupCooldown = PICKUP_REPEAT_SECONDS;
        } else {
          audio.play("craftError", { gain: 0.7 });
          pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
        }
      } else if (containerTarget !== undefined && isContainerKind(containerTarget.kind) && containerEmpty) {
        // Only an empty one comes along; a full one is opened with right mouse.
        if (inventory.tryAdd(CONTAINER_ITEMS[containerTarget.kind])) {
          world.removeProp(containerTarget.id, worldRenderer);
          containers.forget(containerTarget.id);
          audio.play("pickupAlt", { variance: 1 });
          pickupCooldown = PICKUP_REPEAT_SECONDS;
        } else {
          audio.play("craftError", { gain: 0.7 });
          pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
        }
      } else if (ropeTarget !== undefined) {
        // A run of several strings gives them all back.
        const strings = Math.round(ropeTarget.spec.segments / XMAS_LIGHTS.segments);
        if (inventory.tryAdd(ItemType.XmasLights, strings)) {
          ropes.remove(ropeTarget);
          audio.play("pickupAlt", { variance: 1 });
          pickupCooldown = PICKUP_REPEAT_SECONDS;
        } else {
          audio.play("craftError", { gain: 0.7 });
          pickupCooldown = PICKUP_FULL_REPEAT_SECONDS;
        }
      }
    }
    // Right mouse opens the container under the crosshair, beside the inventory.
    if (containerTarget !== undefined && input.wasMousePressed(2)) openInventory(containerTarget.id);
    const promptText =
      target !== undefined
        ? `E  pick up ${itemDisplayName(target.type)}`
        : matTarget !== undefined
          ? `E  pick up ${itemDisplayName(ItemType.Trampoline)}`
          : rockTarget !== undefined
            ? `E  pick up ${itemDisplayName(itemOfBall(rockTarget) ?? ItemType.Rock)}`
            : pieceTarget !== undefined
              ? `E  pick up ${itemDisplayName(pieceTarget.spec.item)}`
              : ropeTarget !== undefined
              ? `E  pick up ${itemDisplayName(ItemType.XmasLights)}`
              : containerTarget !== undefined && isContainerKind(containerTarget.kind)
                ? containerEmpty
                  ? `RMB  open   E  pick up ${CONTAINER_NAMES[containerTarget.kind]}`
                  : "RMB  open"
                : "";
    if (prompt.textContent !== promptText) prompt.textContent = promptText;
    prompt.hidden = promptText === "";

    pickupRenderer.sync(pickups, now);
    trampolineSystem.sync(physics);
    hotbar.sync(inventory);
    recipes.observe(inventory);
    const heldNow = inventory.selectedItem();
    itemControls.set(
      heldNow?.type,
      heldNow?.type === ItemType.XmasLights
        ? {
            placing: ropeFirst !== undefined,
            canExtend: heldNow.count > ropeStrings && ropeStrings < ROPE_MAX_STRINGS,
          }
        : undefined,
    );

    // Before the log system: it keeps the terrain bodies, and building pieces falling ask it for theirs.
    buildSystem.update(rawDt, player.x, player.y, player.z);
    logs?.update(player.x, player.y, player.z);

    avatarPose.held = heldType;
    avatarPose.action = canChup
      ? AvatarAction.Chup
      : canScoop
        ? AvatarAction.Scoop
        : throwCharge > 0
          ? throwKind
          : fishing.charge > 0
            ? AvatarAction.Charge
            : shaking
              ? AvatarAction.Shake
              : AvatarAction.Idle;
    avatarPose.charge = throwCharge > 0 ? throwCharge : fishing.charge;
    if (fishingEvents.cast) {
      // The cast is the spear throw's lunge, with the rod staying in the hand.
      avatarPose.throwSeq = (avatarPose.throwSeq + 1) & 0xff;
      avatarPose.thrown = AvatarAction.Charge;
    }
    if (threw) {
      avatarPose.throwSeq = (avatarPose.throwSeq + 1) & 0xff;
      avatarPose.thrown = throwKind;
      if (throwKind === AvatarAction.Charge) audio.play("throwStick", { variance: 1 });
      else if (throwKind === AvatarAction.Put) audio.play("whiff", { pitch: -4 });
      else if (rolledItemOf(heldType) !== undefined) audio.play("throwStick", { pitch: -12, gain: 0.8 });
      else if (holdingSnowball) audio.play("snowCrunch", { gain: 0.6, variance: 1.5 });
      else audio.play("throwStick", { pitch: -12, gain: 0.8 });
    }

    // On a board, and not lying where it threw you.
    const onBoard = boardEquipped && !player.skate.isDown;
    const rideTarget = onBoard && player.mode === PlayerMode.Walking ? SKATE_BOARD_HEIGHT : 0;
    rideLift += (rideTarget - rideLift) * Math.min(1, rawDt * 14);
    skateboardView.update(player, renderX, renderY, renderZ, onBoard);
    looseBoardsView.sync(looseBoards, alpha);
    snowballsView.sync(snowballs, flyingSnow.flying, alpha);
    vesselsView.sync(vessels.flying, alpha);

    playerModel.update(player, avatarPose, rawDt, renderX, renderY + rideLift, renderZ, rideLift);
    // Hidden in first person: inside the head is all you would see.
    playerModel.visible = playerCamera.perspective !== CameraPerspective.FirstPerson;
    // The arm is the first-person stand-in for it: only while walking, since
    // a ragball has no hand to show.
    arm.visible =
      playerCamera.perspective === CameraPerspective.FirstPerson &&
      player.mode === PlayerMode.Walking;
    arm.update(rawDt, {
      pose: avatarPose,
      walk: Math.min(1, Math.hypot(player.vx, player.vz) / player.walkSpeed),
      grounded: player.grounded,
    });

    const wantCameraY = renderY + rideLift;
    cameraY =
      player.skating && player.grounded
        ? cameraY + (wantCameraY - cameraY) * Math.min(1, rawDt * 25)
        : wantCameraY;
    const skateSpeed = player.skating ? Math.hypot(player.vx, player.vz) : 0;
    playerCamera.fovBoost +=
      (Math.min(1, skateSpeed / SKATE_FOV_SPEED) * SKATE_FOV_BOOST - playerCamera.fovBoost) *
      Math.min(1, rawDt * 4);
    playerCamera.sync(camera, player, sceneQuery, renderX, cameraY, renderZ);

    // The fishing line starts at the rod's tip as drawn: on the arm in first person (which is drawn
    // in the camera's own space), on the model otherwise.
    camera.updateMatrixWorld();
    const rodAnchor = !holdingRod
      ? undefined
      : arm.visible
        ? arm.heldAnchor(ROD_TIP_NAME)
        : playerModel.visible
          ? playerModel.heldAnchor(ROD_TIP_NAME)
          : undefined;
    if (rodAnchor !== undefined) {
      rodAnchor.getWorldPosition(rodTip);
      if (arm.visible) rodTip.applyMatrix4(camera.matrixWorld);
    }
    rodTipSeen = rodAnchor !== undefined;
    fishingView.update(rodAnchor !== undefined ? rodTip : undefined, groundAt);

    // After the camera, because the snow's billboards are built from the
    // camera basis and its box is centred on the camera.
    world.biomeAtMeters(player.x, player.z, atmosphere.weightsBuffer);
    if (spawned && halloweenAmbience.update(rawDt, atmosphere.weightsBuffer.halloween)) {
      audio.play("halloweenAmbient", { gain: 0.45, variance: 3 });
    }
    atmosphere.update(atmosphere.weightsBuffer, now);
    snow.update(camera, now, atmosphere.snowIntensity, atmosphere.blizzard);
    flakeBurst.update(camera, rawDt);
    crumbBurst.update(camera, rawDt, terrainAt);
    shatter.update(rawDt);
    flyingChunks.update(rawDt, terrainAt);
    leaves.update(camera, now, rawDt, atmosphere.weightsBuffer.halloween);

    hud.set("POS", `${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}`);
    hud.set("MODE", player.mode === PlayerMode.Walking ? "walking" : "ragball");
    hud.set("GROUND", player.grounded ? "yes" : "no");
    hud.set("VIEW", playerCamera.perspective === CameraPerspective.FirstPerson ? "1st" : "3rd");
    hud.set("FOV", playerCamera.fovDegrees.toFixed(0));
    hud.set("CHUNKS", `${world.loadedCount} (r${radius}, ${worldRenderer.meshCount} drawn)`);
    hud.set("ITEMS", `${pickups.items.length} (${thrown.count} flying)`);
    hud.set("TREES", `${world.treeCount} (${String(logs?.count ?? 0)} felled)`);
    hud.set("PROPS", String(world.propCount));
    hud.set("QUEUE", String(world.pendingCount));
    hud.set(
      "BIOME",
      `${biomeLabel(atmosphere.weightsBuffer)}${atmosphere.blizzard > 0.01 ? ` blizzard ${(atmosphere.blizzard * 100).toFixed(0)}%` : ""}`,
    );
    hud.set("UPLOAD", `${worstDrainMs.toFixed(1)}ms worst`);
    let rocksLoaded = 0;
    for (const ball of snowballs.balls) if (itemOfBall(ball) === ItemType.Rock) rocksLoaded++;
    hud.set("ROCKS", String(rocksLoaded));
    hud.set("PIECES", `${String(buildField.pieces.length)} (${String(buildSystem.bodyCount)} bodies)`);
    hud.set(
      "AIM",
      onPiece
        ? `${pieceHit.distance.toFixed(2)}m felled piece`
        : onBall
          ? snowballHit.ball !== undefined && itemOfBall(snowballHit.ball) !== undefined
            ? `${snowballHit.distance.toFixed(2)}m ${itemDisplayName(itemOfBall(snowballHit.ball) ?? ItemType.Rock)} ${snowballHit.ball.mass.toFixed(0)}kg`
            : `${snowballHit.distance.toFixed(2)}m snowball x${String(snowballHit.ball?.units ?? 0)}`
          : aimed
        ? `${hit.distance.toFixed(2)}m ${
            hit.kind === HitKind.Tree
              ? hit.treePart === TREE_PART_TRUNK
                ? "trunk"
                : `foliage ${String(hit.treePart)}`
              : hit.kind === HitKind.Prop
                ? (world.getProp(hit.propId)?.kind ?? "prop")
                : "terrain"
          }`
        : "--",
    );
    if (saveManager !== undefined) {
      saveManager.update(rawDt);
      hud.set("SAVE", saveManager.status);
    }
    hud.set("FPS", stats.fps.toFixed(0));
    hud.set("WORST", `${stats.worstMs.toFixed(1)}ms`);
    hud.set(
      "LOOK",
      input.locked ? "captured (Esc to release)" : (input.lockError ?? "click to capture mouse"),
    );
    crosshair.hidden = !active;
    const mouseText =
      input.locked || inventoryScreen.open ? "" : (input.lockError ?? "click to capture mouse");
    if (mouseHint.textContent !== mouseText) mouseHint.textContent = mouseText;
    mouseHint.hidden = mouseText === "";
    if (mapView.open) mapView.render(mapData, player.x, player.z, player.frontX, player.frontZ);

    lowRes.begin();
    renderer.render(scene, camera);
    arm.render(renderer, camera);
    lowRes.present();
    hotbar.render(renderer, now);
    inventoryScreen.render(renderer, now);
    input.endFrame();
  });

  // Vite replaces this module on edit without reloading the page, which
  // would otherwise leave the old module's workers running and its GPU
  // buffers allocated -- a few edits in and the tab is holding several
  // worlds at once.
  import.meta.hot?.dispose(() => {
    void renderer.setAnimationLoop(null);
    saveManager?.save(true);
    saveManager?.dispose();
    input.dispose();
    playerModel.dispose();
    arm.dispose();
    lowRes.dispose();
    hotbar.dispose();
    inventoryScreen.dispose();
    flyingChunks.clear();
    shatter.clear();
    placementPreview.dispose();
    skateboardView.dispose();
    looseBoardsView.dispose();
    snowballsView.dispose();
    vesselsView.dispose();
    gooStains.dispose();
    snowPuffs.dispose();
    pickupRenderer.clear();
    thrown.clear();
    trampolineSystem.clear(physics);
    logs?.clear();
    treeRenderer.clear();
    physics?.dispose();
    worldRenderer.clear();
    world.dispose();
  });
}

void start().catch((err: unknown) => {
  console.error(err);
  const stats = document.querySelector("#stats");
  if (stats !== null) stats.textContent = `startup failed: ${String(err)}`;
});
