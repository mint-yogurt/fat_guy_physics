import "./ui/ui.css";

// Everything comes from "three/webgpu", never from "three". The webgpu entry
// bundles its own copy of three's core, so mixing the two imports loads the
// library twice -- three warns about it at runtime, and it doubles the
// bundle while making `instanceof` checks across the boundary fail.
// three/webgpu re-exports all of Three.Core, so there is never a reason to
// reach for the bare "three" specifier in this package.
import {
  Color,
  PerspectiveCamera,
  Scene,
  TextureLoader,
  type Texture,
} from "three/webgpu";

import { MAX_FRAME_TIME, VOXEL_SIZE } from "@fgp/shared/sim/constants";
import { DEFAULT_LOAD_RADIUS_CHUNKS, World } from "@fgp/shared/sim/world";

import { FlyCamera } from "./input/flyCamera.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { createVoxelMaterial } from "./render/voxelMaterial.ts";
import { WorldRenderer } from "./render/worldRenderer.ts";
import { FrameStats, Hud } from "./ui/hud.ts";

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
 * Yields long enough for the browser to actually paint.
 *
 * One rAF only schedules work for the *next* frame; the paint happens after
 * the callback returns. Waiting two frames is what guarantees the first one
 * reached the screen -- which matters here because the thing being painted is
 * the "generating" message that covers a multi-second synchronous stall.
 *
 * Raced against a timer because a hidden tab does not run rAF *at all* --
 * not throttled, suspended. Opening the game in a background tab would
 * otherwise deadlock startup here until the tab was focused, which looks
 * exactly like a crash. There is nothing to paint in a hidden tab anyway, so
 * the timeout just gets on with it.
 */
function nextPaint(timeoutMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    setTimeout(finish, timeoutMs);
  });
}

/**
 * Load radius in chunks. Overridable via `?radius=N` purely for iteration
 * speed: the M2 initial load is synchronous, and at the default radius that
 * is a multi-second freeze on every page reload. `?radius=2` makes it
 * instant while developing anything that is not streaming itself.
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
  const world = new World(SEED, radius);
  const worldRenderer = new WorldRenderer(scene, material);

  camera.position.set(
    0,
    world.surfaceHeightVoxels(0, 0) * VOXEL_SIZE + SPAWN_CLEARANCE,
    0,
  );

  const flyCamera = new FlyCamera(camera, canvas);
  flyCamera.attach();

  installResizeHandler(bundle, (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  // M2: every chunk load is synchronous on the main thread, so the initial
  // full-radius load freezes the tab outright. Paint the sky and a message
  // first so the freeze is explained rather than looking like a hang. The
  // fix is M3 (workers), not a longer loading screen.
  hud.set("STATUS", `generating ${radius}-chunk radius...`);
  renderer.render(scene, camera);
  await nextPaint();

  // Seeded from the initial load rather than starting at zero, so the
  // readout accounts for the stall the player actually sat through instead
  // of only the boundary crossings that happen after spawn.
  let worstStreamMs = world.update(camera.position.x, camera.position.z, worldRenderer).ms;
  hud.remove("STATUS");

  let lastTime = performance.now() / 1000;

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

    const streamed = world.update(camera.position.x, camera.position.z, worldRenderer);
    if (streamed.ms > worstStreamMs) worstStreamMs = streamed.ms;

    hud.set("POS", `${camera.position.x.toFixed(1)} ${camera.position.y.toFixed(1)} ${camera.position.z.toFixed(1)}`);
    hud.set("CHUNKS", `${world.loadedCount} (r${radius}, ${worldRenderer.meshCount} drawn)`);
    hud.set("STREAM", `${worstStreamMs.toFixed(1)}ms worst`);
    hud.set("FPS", stats.fps.toFixed(0));
    hud.set("WORST", `${stats.worstMs.toFixed(1)}ms`);
    hud.set("LOOK", flyCamera.locked ? "captured (Esc to release)" : "click to capture mouse");

    renderer.render(scene, camera);
  });
}

void start().catch((err: unknown) => {
  console.error(err);
  const stats = document.querySelector("#stats");
  if (stats !== null) stats.textContent = `startup failed: ${String(err)}`;
});
