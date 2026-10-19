import "./ui/ui.css";

// Everything comes from "three/webgpu", never from "three". The webgpu entry
// bundles its own copy of three's core, so mixing the two imports loads the
// library twice -- three warns about it at runtime, and it doubles the
// bundle while making `instanceof` checks across the boundary fail.
// three/webgpu re-exports all of Three.Core, so there is never a reason to
// reach for the bare "three" specifier in this package.
import { Color, PerspectiveCamera, Scene, TextureLoader, type Texture } from "three/webgpu";

import { MAX_FRAME_TIME, VOXEL_SIZE } from "@fgp/shared/sim/constants";
import { DEFAULT_LOAD_RADIUS_CHUNKS, World } from "@fgp/shared/sim/world";

import { FlyCamera } from "./input/flyCamera.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { createVoxelMaterial } from "./render/voxelMaterial.ts";
import { WorldRenderer } from "./render/worldRenderer.ts";
import { FrameStats, Hud } from "./ui/hud.ts";
import { WorkerChunkSource } from "./workers/workerChunkSource.ts";

/** Matches the seed the golden fixture was generated with. */
const SEED = 1337;

/** Metres above the ground to spawn the fly camera. */
const SPAWN_CLEARANCE = 6;

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing required element: ${selector}`);
  return el;
}

function loadTexture(url: string): Promise<Texture> {
  return new TextureLoader().loadAsync(url);
}

/**
 * Load radius in chunks, overridable via `?radius=N`.
 *
 * Kept after M3 even though the initial load no longer blocks: it is the
 * fastest way to tell "slow because there is a lot of terrain" apart from
 * "slow for some other reason".
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

  const camera = new PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);

  // assets/ is served from the repo root via Vite's publicDir, so these paths
  // mirror the C++'s asset layout rather than being a second copy.
  const cobble = await loadTexture("/textures/cobble.png");
  const material = createVoxelMaterial(cobble);

  const radius = loadRadiusFromUrl();
  const source = new WorkerChunkSource(SEED);
  const world = new World(SEED, source, radius);
  const worldRenderer = new WorldRenderer(scene, material);
  hud.set("WORKERS", String(source.workerCount));

  camera.position.set(0, world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE + SPAWN_CLEARANCE, 0);

  const flyCamera = new FlyCamera(camera, canvas);
  flyCamera.attach();

  installResizeHandler(bundle, (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // Nothing is awaited before the loop starts. The initial load is just the
  // first streaming update: chunks are submitted to the workers here and
  // arrive over the next second or so, nearest-first, while the frame loop
  // keeps running. That replaces M2's multi-second synchronous freeze.
  world.update(camera.position.x, camera.position.z, worldRenderer);

  let lastTime = performance.now() / 1000;
  let worstDrainMs = 0;

  void renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const rawDt = now - lastTime;
    lastTime = now;

    stats.sample(rawDt);
    const dt = Math.min(rawDt, MAX_FRAME_TIME);

    // A collapsed viewport has no valid swapchain to present into. Bail
    // before touching the renderer rather than letting it fail per frame.
    if (!isRenderable()) return;

    flyCamera.update(dt);

    world.update(camera.position.x, camera.position.z, worldRenderer);
    // Every frame, not only on boundary crossings -- otherwise finished
    // chunks sit in the queue until the player happens to move again.
    const drainMs = world.drain(worldRenderer);
    if (drainMs > worstDrainMs) worstDrainMs = drainMs;

    hud.set(
      "POS",
      `${camera.position.x.toFixed(1)} ${camera.position.y.toFixed(1)} ${camera.position.z.toFixed(1)}`,
    );
    hud.set("CHUNKS", `${world.loadedCount} (r${radius}, ${worldRenderer.meshCount} drawn)`);
    hud.set("QUEUE", String(world.pendingCount));
    hud.set("UPLOAD", `${worstDrainMs.toFixed(1)}ms worst`);
    hud.set("FPS", stats.fps.toFixed(0));
    hud.set("WORST", `${stats.worstMs.toFixed(1)}ms`);
    hud.set(
      "LOOK",
      flyCamera.locked
        ? "captured (Esc to release)"
        : (flyCamera.lockError ?? "click to capture mouse"),
    );

    renderer.render(scene, camera);
  });

  // Vite replaces this module on edit without reloading the page, which
  // would otherwise leave the old module's workers running and its GPU
  // buffers allocated -- a few edits in and the tab is holding several
  // worlds at once.
  import.meta.hot?.dispose(() => {
    void renderer.setAnimationLoop(null);
    flyCamera.dispose();
    worldRenderer.clear();
    world.dispose();
  });
}

void start().catch((err: unknown) => {
  console.error(err);
  const stats = document.querySelector("#stats");
  if (stats !== null) stats.textContent = `startup failed: ${String(err)}`;
});
