import "./ui/ui.css";

// Everything comes from "three/webgpu", never from "three". The webgpu entry
// bundles its own copy of three's core, so mixing the two imports loads the
// library twice -- three warns about it at runtime, and it doubles the
// bundle while making `instanceof` checks across the boundary fail.
// three/webgpu re-exports all of Three.Core, so there is never a reason to
// reach for the bare "three" specifier in this package.
import { Color, PerspectiveCamera, Scene, TextureLoader, type Texture } from "three/webgpu";

import {
  FIXED_TIMESTEP,
  MAX_FRAME_TIME,
  MAX_SUBSTEPS,
  VOXEL_SIZE,
} from "@fgp/shared/sim/constants";
import { createPlayerInput, Player, PlayerMode } from "@fgp/shared/sim/player";
import { DEFAULT_LOAD_RADIUS_CHUNKS, World } from "@fgp/shared/sim/world";
import { createVoxelHit, raycastVoxel } from "@fgp/shared/voxel/voxelRaycast";

import { InputState } from "./input/inputState.ts";
import { CameraPerspective, PlayerCamera } from "./render/playerCamera.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { createVoxelMaterial } from "./render/voxelMaterial.ts";
import { WorldRenderer } from "./render/worldRenderer.ts";
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

/** Matches the C++ FOV adjust step on the -/= keys. */
const FOV_STEP = 2;
const FOV_MIN = 50;
const FOV_MAX = 120;

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
  const canvas = requireElement<HTMLCanvasElement>("#viewport");
  const bundle = await createRenderer(canvas);
  const { renderer } = bundle;

  const hud = new Hud(requireElement<HTMLDivElement>("#stats"));
  const stats = new FrameStats();
  hud.set("BACKEND", bundle.backend + (bundle.forcedWebGL ? " (forced via ?gl)" : ""));

  const scene = new Scene();
  scene.background = new Color(0x87b8dc); // the C++ clear colour (0.53, 0.72, 0.86)

  const camera = new PerspectiveCamera(90, window.innerWidth / window.innerHeight, 0.1, 100);

  // assets/ is served from the repo root via Vite's publicDir, so these paths
  // mirror the C++'s asset layout rather than being a second copy.
  const cobble = await loadTexture("/textures/cobble.png");
  const material = createVoxelMaterial(cobble);

  const radius = loadRadiusFromUrl();
  const source = new WorkerChunkSource(SEED);
  const world = new World(SEED, source, radius);
  const worldRenderer = new WorldRenderer(scene, material);
  hud.set("WORKERS", String(source.workerCount));

  const spawnY = world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE + SPAWN_CLEARANCE;
  const player = new Player(0, spawnY, 0);
  const playerCamera = new PlayerCamera();

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

  // Scoop state. `hit` doubles as the crosshair readout's source, so it is
  // refreshed once a frame whether or not the player is digging.
  const hit = createVoxelHit();
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

    if (input.wasPressed("KeyR")) player.toggleMode(world);
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
      player.update(playerInput, FIXED_TIMESTEP, world, spawnSurface);
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

    raycastVoxel(
      world,
      eyeX,
      eyeY,
      eyeZ,
      player.frontX,
      player.frontY,
      player.frontZ,
      DIG_REACH_METERS,
      hit,
    );

    // Walking only: there is no hand free to swing while tucked into a ball.
    const canDig =
      input.locked && player.mode === PlayerMode.Walking && input.isMouseDown(0);

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
          if (hit.hit) {
            digAnchored = true;
            anchorOriginX = eyeX;
            anchorOriginY = eyeY;
            anchorOriginZ = eyeZ;
            anchorDirX = player.frontX;
            anchorDirY = player.frontY;
            anchorDirZ = player.frontZ;
            anchorCenterX = (hit.x + 0.5) * VOXEL_SIZE;
            anchorCenterY = (hit.y + 0.5) * VOXEL_SIZE;
            anchorCenterZ = (hit.z + 0.5) * VOXEL_SIZE;
          } else {
            digAnchored = false;
          }
        }

        if (digAnchored) {
          world.digSphere(
            anchorCenterX,
            anchorCenterY,
            anchorCenterZ,
            DIG_RADIUS_METERS,
            worldRenderer,
          );
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

    playerCamera.sync(camera, player, world, renderX, renderY, renderZ);

    hud.set("POS", `${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}`);
    hud.set("MODE", player.mode === PlayerMode.Walking ? "walking" : "ragball");
    hud.set("GROUND", player.grounded ? "yes" : "no");
    hud.set("VIEW", playerCamera.perspective === CameraPerspective.FirstPerson ? "1st" : "3rd");
    hud.set("FOV", playerCamera.fovDegrees.toFixed(0));
    hud.set("CHUNKS", `${world.loadedCount} (r${radius}, ${worldRenderer.meshCount} drawn)`);
    hud.set("QUEUE", String(world.pendingCount));
    hud.set("UPLOAD", `${worstDrainMs.toFixed(1)}ms worst`);
    hud.set("AIM", hit.hit ? `${hit.distance.toFixed(2)}m` : "--");
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
    worldRenderer.clear();
    world.dispose();
  });
}

void start().catch((err: unknown) => {
  console.error(err);
  const stats = document.querySelector("#stats");
  if (stats !== null) stats.textContent = `startup failed: ${String(err)}`;
});
