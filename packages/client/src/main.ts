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
  Scene,
  TextureLoader,
  type Texture,
} from "three/webgpu";

import {
  FIXED_TIMESTEP,
  MAX_FRAME_TIME,
  MAX_SUBSTEPS,
  VOXEL_SIZE,
} from "@fgp/shared/sim/constants";
import { createPlayerInput, Player, PlayerMode } from "@fgp/shared/sim/player";
import { HOTBAR_SLOTS, Inventory, ItemType } from "@fgp/shared/items/inventory";
import { PickupField } from "@fgp/shared/items/pickupField";
import { SceneSolidQuery } from "@fgp/shared/sim/sceneQuery";
import {
  createSceneHit,
  DEFAULT_LOAD_RADIUS_CHUNKS,
  HitKind,
  World,
} from "@fgp/shared/sim/world";

import { Atmosphere } from "./render/atmosphere.ts";
import { InputState } from "./input/inputState.ts";
import { LogSystem } from "./physics/logSystem.ts";
import { PhysicsWorld } from "./physics/physicsWorld.ts";
import { CameraPerspective, PlayerCamera } from "./render/playerCamera.ts";
import { PickupRenderer } from "./render/pickupRenderer.ts";
import { PlayerModel } from "./render/playerModel.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { Snow } from "./render/snow.ts";
import { createVoxelMaterial } from "./render/voxelMaterial.ts";
import { WorldRenderer } from "./render/worldRenderer.ts";
import { askAppearance } from "./ui/characterCreate.ts";
import { Hotbar } from "./ui/hotbar.ts";
import { FrameStats, Hud } from "./ui/hud.ts";
import { WorkerChunkSource } from "./workers/workerChunkSource.ts";

/** Matches the seed the golden fixture was generated with. */
const SEED = 1337;

/** Metres above the ground to spawn, so the player falls onto terrain. */
const SPAWN_CLEARANCE = 2;

/**
 * Scoop tuning, from src/main.cpp. The anchor epsilons are the interesting
 * ones: re-raycasting every tick while the player holds still would walk the
 * dig point deeper along the view ray, drilling a tunnel instead of
 * hollowing out one spot. So the first tick of a gesture raycasts, and
 * subsequent ticks reuse that hit point until the eye moves 5cm or the aim
 * turns ~5.7 degrees.
 */
const DIG_TICK_SECONDS = 0.35;
const DIG_REACH_METERS = 5;
const DIG_RADIUS_METERS = 0.35;
const DIG_REANCHOR_POSITION = 0.05;
const DIG_REANCHOR_DIRECTION = 0.995;

/**
 * Chup (chop) tuning, also from src/main.cpp. A thin shear rather than a
 * gouge: wide enough in X/Z to cover the thickest trunk, ~1 voxel thick in
 * Y, so clearing a trunk's whole cross-section takes several swings.
 */
/** Chance a clearing tick drops something. Rolled once per tick, as in the C++. */
const LEAF_DROP_CHANCE = 0.35;
const STICK_DROP_CHANCE = 0.4;

const CHUP_TICK_SECONDS = 0.25;
const CHUP_HORIZONTAL_RADIUS = 0.22;
const CHUP_VERTICAL_HALF_THICKNESS = 0.06;

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

function loadTexture(url: string): Promise<Texture> {
  return new TextureLoader().loadAsync(url);
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
  const appearance = await askAppearance(requireElement<HTMLDivElement>("#charcreate"));

  const canvas = requireElement<HTMLCanvasElement>("#viewport");
  const bundle = await createRenderer(canvas);
  const { renderer } = bundle;

  const hud = new Hud(requireElement<HTMLDivElement>("#stats"));
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

  // assets/ is served from the repo root via Vite's publicDir, so these paths
  // mirror the C++'s asset layout rather than being a second copy.
  const cobble = await loadTexture("/textures/cobble.png");
  const voxelMaterial = createVoxelMaterial(cobble);
  const material = voxelMaterial.material;
  const bushTexture = await loadTexture("/billboard/bush.png");

  const radius = loadRadiusFromUrl();
  const source = new WorkerChunkSource(SEED);
  const world = new World(SEED, source, radius);
  const worldRenderer = new WorldRenderer(scene, material, bushTexture);
  hud.set("WORKERS", String(source.workerCount));

  const atmosphere = new Atmosphere(scene, voxelMaterial, hemisphere, sun, radius);
  const snow = new Snow(scene);

  // Everything that collides goes through this rather than the World
  // directly: terrain plus whatever settled rigid bodies the player is
  // allowed to stand on.
  const sceneQuery = new SceneSolidQuery(world);

  const spawnY = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE + SPAWN_CLEARANCE;
  const player = new Player(0, spawnY, 0);
  const playerCamera = new PlayerCamera();
  const playerModel = await PlayerModel.load(scene, appearance);
  hud.set("NAME", appearance.name);

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
      logs = new LogSystem(created, world, sceneQuery, scene, material);
      worldRenderer.onSevered = (piece, x, y, z, r) => {
        logs?.spawn(piece, x, y, z, r);
      };
      hud.set("PHYSICS", "jolt");
    })
    .catch((err: unknown) => {
      hud.set("PHYSICS", `unavailable: ${String(err)}`);
    });

  const inventory = new Inventory();
  const hotbar = new Hotbar(requireElement<HTMLDivElement>("#hotbar"));
  const pickups = new PickupField();
  const pickupRenderer = new PickupRenderer(scene);

  /** Drops an item at a clearing point, to fall onto the terrain below. */
  const dropItem = (type: ItemType, x: number, y: number, z: number): void => {
    const groundY =
      world.surfaceHeightVoxels(Math.floor(x / VOXEL_SIZE), Math.floor(z / VOXEL_SIZE)) *
      VOXEL_SIZE;
    pickups.spawn(type, x, y, z, groundY, performance.now() / 1000);
  };

  const input = new InputState(canvas);
  input.attach();
  const playerInput = createPlayerInput();

  installResizeHandler(bundle, (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
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

  const spawnSurface = (): number => world.surfaceHeightVoxels(0, 0);

  let prevX = player.x;
  let prevY = player.y;
  let prevZ = player.z;

  const crosshair = requireElement<HTMLDivElement>("#crosshair");

  // Scoop/chup state. `hit` doubles as the crosshair readout's source, so
  // it is refreshed once a frame whether or not the player is acting.
  const hit = createSceneHit();
  let chupCooldown = 0;
  let digCooldown = 0;
  let digAnchored = false;
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
      pickups,
      inventory,
      scene,
      camera,
      atmosphere,
      snow,
      voxelMaterial,
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
    if (input.locked) {
      player.look(input.consumeMouseX(), input.consumeMouseY());
    }

    for (let slot = 0; slot < HOTBAR_SLOTS; slot++) {
      if (input.wasPressed(`Digit${String(slot + 1)}`)) inventory.selectSlot(slot);
    }

    if (input.wasPressed("KeyR")) player.toggleMode(sceneQuery);
    if (input.wasPressed("KeyV")) playerCamera.togglePerspective();
    if (input.wasPressed("Minus")) {
      playerCamera.fovDegrees = Math.max(FOV_MIN, playerCamera.fovDegrees - FOV_STEP);
    }
    if (input.wasPressed("Equal")) {
      playerCamera.fovDegrees = Math.min(FOV_MAX, playerCamera.fovDegrees + FOV_STEP);
    }

    playerInput.moveX = (input.isDown("KeyD") ? 1 : 0) - (input.isDown("KeyA") ? 1 : 0);
    playerInput.moveZ = (input.isDown("KeyW") ? 1 : 0) - (input.isDown("KeyS") ? 1 : 0);
    // Edge-triggered, then latched for the whole frame: the jump has to
    // survive to whichever substep runs it, but must not fire in more than
    // one of them.
    playerInput.jumpPressed = input.wasPressed("Space");

    // Clamp BEFORE accumulating so a long stall -- alt-tab, a GC pause, a
    // breakpoint -- cannot dump a huge backlog of substeps into the next
    // frame.
    accumulator += Math.min(rawDt, MAX_FRAME_TIME);

    if (!spawned && world.hasChunkAt(player.x, player.y, player.z)) spawned = true;

    let substeps = 0;
    while (spawned && accumulator >= FIXED_TIMESTEP && substeps < MAX_SUBSTEPS) {
      prevX = player.x;
      prevY = player.y;
      prevZ = player.z;
      player.update(playerInput, FIXED_TIMESTEP, sceneQuery, spawnSurface);
      // Bodies step on the same fixed clock as the player, so a falling log
      // behaves identically whatever the display rate is.
      physics?.step(FIXED_TIMESTEP);
      // Consumed: a single keypress is one impulse, not one per substep.
      playerInput.jumpPressed = false;
      accumulator -= FIXED_TIMESTEP;
      substeps++;
    }
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
      DIG_REACH_METERS,
      hit,
    );
    const aimed = hit.kind !== HitKind.None;

    // Walking only: there is no hand free to swing while tucked into a ball.
    // Scoop and chup are the Unarmed slot's actions: holding an item means
    // your hands are full. It is the whole of the tool system for now, and
    // the natural place future tools hook in.
    const canDig =
      input.locked &&
      player.mode === PlayerMode.Walking &&
      inventory.isUnarmedSelected &&
      input.isMouseDown(0);

    if (canDig) {
      digCooldown -= rawDt;
      if (digCooldown <= 0) {
        const sameAnchor =
          digAnchored &&
          Math.hypot(eyeX - anchorOriginX, eyeY - anchorOriginY, eyeZ - anchorOriginZ) <=
            DIG_REANCHOR_POSITION &&
          player.frontX * anchorDirX + player.frontY * anchorDirY + player.frontZ * anchorDirZ >=
            DIG_REANCHOR_DIRECTION;

        if (!sameAnchor) {
          if (aimed) {
            digAnchored = true;
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
          } else {
            digAnchored = false;
          }
        }

        if (digAnchored) {
          if (anchorTreeId >= 0) {
            const cleared = world.digTree(
              anchorTreeId,
              anchorCenterX,
              anchorCenterY,
              anchorCenterZ,
              DIG_RADIUS_METERS,
              worldRenderer,
            );
            if (cleared && Math.random() < LEAF_DROP_CHANCE) {
              dropItem(ItemType.Leaf, anchorCenterX, anchorCenterY, anchorCenterZ);
            }
          } else {
            world.digSphere(
              anchorCenterX,
              anchorCenterY,
              anchorCenterZ,
              DIG_RADIUS_METERS,
              worldRenderer,
            );
          }
        }
        digCooldown = DIG_TICK_SECONDS;
      }
    } else {
      // Clamped at zero rather than left to run negative, so a
      // release-then-repress cannot fire a queued burst. Releasing also
      // drops the anchor: the next press always starts a fresh gesture.
      digCooldown = 0;
      digAnchored = false;
    }

    // Chup is right mouse, and unlike the scoop it re-raycasts every tick:
    // the cut is a thin shear that has to follow the trunk as it is eaten
    // away, so anchoring it would make repeat swings miss.
    const canChup =
      input.locked &&
      player.mode === PlayerMode.Walking &&
      inventory.isUnarmedSelected &&
      input.isMouseDown(2);
    if (canChup) {
      chupCooldown -= rawDt;
      if (chupCooldown <= 0) {
        if (hit.kind === HitKind.Tree) {
          // Aim at the trunk axis at the height you are looking at, not at
          // the exact voxel under the crosshair. A tree is mostly canopy,
          // so hitting the actual trunk by eye means finding a 20cm pole
          // inside a bush -- and every miss just shaves leaves, which
          // reads as "chopping does not work".
          const tree = world.getTree(hit.treeId);
          const chopX = tree === undefined ? hit.centerX : (tree.rootVoxelX + 0.5) * VOXEL_SIZE;
          const chopZ = tree === undefined ? hit.centerZ : (tree.rootVoxelZ + 0.5) * VOXEL_SIZE;
          const cleared = world.chopTree(
            hit.treeId,
            chopX,
            hit.centerY,
            chopZ,
            CHUP_HORIZONTAL_RADIUS,
            CHUP_VERTICAL_HALF_THICKNESS,
            worldRenderer,
          );
          if (cleared) {
            const roll = Math.random();
            if (roll < STICK_DROP_CHANCE) {
              dropItem(ItemType.Stick, chopX, hit.centerY, chopZ);
            } else if (roll < STICK_DROP_CHANCE + LEAF_DROP_CHANCE) {
              dropItem(ItemType.Leaf, chopX, hit.centerY, chopZ);
            }
          }
        }
        chupCooldown = CHUP_TICK_SECONDS;
      }
    } else {
      chupCooldown = 0;
    }

    pickups.update(rawDt, now, player.x, player.y, player.z, inventory);
    pickupRenderer.sync(pickups);
    hotbar.sync(inventory);

    logs?.update(player.x, player.y, player.z);

    playerModel.update(player, rawDt, renderX, renderY, renderZ);
    // Hidden in first person: inside the head is all you would see.
    playerModel.visible = playerCamera.perspective !== CameraPerspective.FirstPerson;

    playerCamera.sync(camera, player, sceneQuery, renderX, renderY, renderZ);

    // After the camera, because the snow's billboards are built from the
    // camera basis and its box is centred on the camera.
    world.biomeAtMeters(player.x, player.z, atmosphere.weightsBuffer);
    atmosphere.update(atmosphere.weightsBuffer, now);
    snow.update(camera, now, atmosphere.snowIntensity, atmosphere.blizzard);

    hud.set("POS", `${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}`);
    hud.set("MODE", player.mode === PlayerMode.Walking ? "walking" : "ragball");
    hud.set("GROUND", player.grounded ? "yes" : "no");
    hud.set("VIEW", playerCamera.perspective === CameraPerspective.FirstPerson ? "1st" : "3rd");
    hud.set("FOV", playerCamera.fovDegrees.toFixed(0));
    hud.set("CHUNKS", `${world.loadedCount} (r${radius}, ${worldRenderer.meshCount} drawn)`);
    hud.set("ITEMS", String(pickups.items.length));
    hud.set("TREES", `${world.treeCount} (${String(logs?.count ?? 0)} logs)`);
    hud.set("QUEUE", String(world.pendingCount));
    hud.set(
      "BIOME",
      `${biomeLabel(atmosphere.weightsBuffer)}${atmosphere.blizzard > 0.01 ? ` blizzard ${(atmosphere.blizzard * 100).toFixed(0)}%` : ""}`,
    );
    hud.set("UPLOAD", `${worstDrainMs.toFixed(1)}ms worst`);
    hud.set(
      "AIM",
      aimed
        ? `${hit.distance.toFixed(2)}m ${hit.kind === HitKind.Tree ? "tree" : "terrain"}`
        : "--",
    );
    hud.set("FPS", stats.fps.toFixed(0));
    hud.set("WORST", `${stats.worstMs.toFixed(1)}ms`);
    hud.set(
      "LOOK",
      input.locked ? "captured (Esc to release)" : (input.lockError ?? "click to capture mouse"),
    );
    crosshair.hidden = !input.locked;

    renderer.render(scene, camera);
    input.endFrame();
  });

  // Vite replaces this module on edit without reloading the page, which
  // would otherwise leave the old module's workers running and its GPU
  // buffers allocated -- a few edits in and the tab is holding several
  // worlds at once.
  import.meta.hot?.dispose(() => {
    void renderer.setAnimationLoop(null);
    input.dispose();
    playerModel.dispose();
    pickupRenderer.clear();
    logs?.clear();
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
