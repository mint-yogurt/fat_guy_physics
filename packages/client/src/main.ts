import "./ui/ui.css";

// Everything comes from "three/webgpu", never from "three". The webgpu entry
// bundles its own copy of three's core, so mixing the two imports loads the
// library twice -- three warns about it at runtime, and it doubles the
// bundle while making `instanceof` checks across the boundary fail.
// three/webgpu re-exports all of Three.Core, so there is never a reason to
// reach for the bare "three" specifier in this package.
import {
  Color,
  Mesh,
  PerspectiveCamera,
  Scene,
  TextureLoader,
  type Texture,
} from "three/webgpu";

import { CHUNK_SIZE, MAX_FRAME_TIME, VOXEL_SIZE } from "@fgp/shared/sim/constants";
import { Mesher } from "@fgp/shared/voxel/greedyMesher";
import { createChunkGrid } from "@fgp/shared/voxel/voxelGrid";
import { TerrainGenerator } from "@fgp/shared/worldgen/terrainGenerator";

import { createChunkGeometry } from "./render/chunkGeometry.ts";
import { createRenderer, installResizeHandler, isRenderable } from "./render/renderer.ts";
import { createVoxelMaterial } from "./render/voxelMaterial.ts";
import { FrameStats, Hud } from "./ui/hud.ts";

/** Matches the seed the golden fixture was generated with. */
const SEED = 1337;

/** The surface band at this seed. Chunk layer 2 covers voxel Y 64..95. */
const CHUNK_COORD = { x: 0, y: 2, z: 0 };

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing required element: ${selector}`);
  return el;
}

function loadTexture(url: string): Promise<Texture> {
  return new TextureLoader().loadAsync(url);
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

  // M1: one chunk, generated and meshed on the main thread. Streaming is M2,
  // workers are M3.
  const generator = new TerrainGenerator(SEED);
  const grid = createChunkGrid();

  const genStart = performance.now();
  generator.generate(grid, CHUNK_COORD.x, CHUNK_COORD.y, CHUNK_COORD.z);
  const genMs = performance.now() - genStart;

  const meshStart = performance.now();
  const mesh = new Mesher().mesh(grid);
  const meshMs = performance.now() - meshStart;

  const chunkMesh = new Mesh(createChunkGeometry(mesh), material);
  const chunkMeters = CHUNK_SIZE * VOXEL_SIZE;
  chunkMesh.position.set(
    CHUNK_COORD.x * chunkMeters,
    CHUNK_COORD.y * chunkMeters,
    CHUNK_COORD.z * chunkMeters,
  );
  scene.add(chunkMesh);

  hud.set("CHUNK", `${CHUNK_COORD.x},${CHUNK_COORD.y},${CHUNK_COORD.z}`);
  hud.set("VERTS", String(mesh.vertexCount));
  hud.set("GEN", `${genMs.toFixed(2)}ms`);
  hud.set("MESH", `${meshMs.toFixed(2)}ms`);

  // Orbit the chunk's centre. A real camera arrives with the player at M4;
  // this exists only so every face of the mesh can be inspected.
  const centre = {
    x: chunkMesh.position.x + chunkMeters / 2,
    y: chunkMesh.position.y + chunkMeters / 2,
    z: chunkMesh.position.z + chunkMeters / 2,
  };
  const orbitRadius = chunkMeters * 1.6;

  installResizeHandler(bundle, (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  let lastTime = performance.now() / 1000;
  let orbitAngle = 0;

  void renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const rawDt = now - lastTime;
    lastTime = now;

    stats.sample(rawDt);
    const dt = Math.min(rawDt, MAX_FRAME_TIME);

    // A collapsed viewport has no valid swapchain to present into. Bail
    // before touching the renderer rather than letting it fail per frame.
    if (!isRenderable()) return;

    orbitAngle += dt * 0.25;
    camera.position.set(
      centre.x + Math.cos(orbitAngle) * orbitRadius,
      centre.y + chunkMeters * 0.55,
      centre.z + Math.sin(orbitAngle) * orbitRadius,
    );
    camera.lookAt(centre.x, centre.y, centre.z);

    hud.set("FPS", stats.fps.toFixed(0));
    hud.set("WORST", `${stats.worstMs.toFixed(1)}ms`);

    renderer.render(scene, camera);
  });
}

void start().catch((err: unknown) => {
  console.error(err);
  const stats = document.querySelector("#stats");
  if (stats !== null) stats.textContent = `startup failed: ${String(err)}`;
});
