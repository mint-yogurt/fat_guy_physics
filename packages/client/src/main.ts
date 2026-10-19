import "./ui/ui.css";

import { BoxGeometry, Mesh, MeshStandardNodeMaterial, PerspectiveCamera, Scene } from "three/webgpu";
import { AmbientLight, Color, DirectionalLight } from "three";

import { MAX_FRAME_TIME, VOXEL_SIZE } from "@fgp/shared/sim/constants";

import { createRenderer, installResizeHandler } from "./render/renderer.ts";
import { FrameStats, Hud } from "./ui/hud.ts";

function requireElement<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing required element: ${selector}`);
  return el;
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
  camera.position.set(2.5, 2, 6);
  camera.lookAt(0, 0, 0);

  // M0 placeholder: a cube scaled to one chunk edge (3.2m) so the sense of
  // scale is right from the start and the real terrain lands at the same size.
  const chunkEdge = VOXEL_SIZE * 32;
  const cube = new Mesh(
    new BoxGeometry(chunkEdge, chunkEdge, chunkEdge),
    new MeshStandardNodeMaterial({ color: 0x8a6a4a, roughness: 0.85 }),
  );
  scene.add(cube);

  scene.add(new AmbientLight(0xffffff, 1.1));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(0.4, 1, 0.25);
  scene.add(sun);

  installResizeHandler(bundle, (w, h) => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  });

  let lastTime = performance.now() / 1000;

  // setAnimationLoop rather than a hand-rolled requestAnimationFrame: on the
  // WebGPU backend it is also what drives XR and ensures the renderer is
  // initialized before the first render.
  void renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const rawDt = now - lastTime;
    lastTime = now;

    stats.sample(rawDt);

    // The clamp that the real frame loop will apply before accumulating
    // substeps (see MAX_FRAME_TIME). Applied here too so the placeholder
    // animation can't take a giant jump after an alt-tab.
    const dt = Math.min(rawDt, MAX_FRAME_TIME);

    cube.rotation.x += dt * 0.4;
    cube.rotation.y += dt * 0.6;

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
