import { WebGPURenderer } from "three/webgpu";

/**
 * Renderer setup.
 *
 * One renderer, two backends: WebGPURenderer uses WebGPU where available and
 * falls back to WebGL2 on its own, so there are no separate code paths. The
 * practical consequence for this project is that WebGL2 is the compatibility
 * floor every custom material has to work on -- which is why materials are
 * written in TSL rather than as raw GLSL ShaderMaterials.
 *
 * `?gl` in the query string forces the WebGL2 backend. That's for A/B
 * debugging: when something renders wrong it matters a great deal whether it's
 * wrong on both backends or only one, and flipping it via URL beats a rebuild.
 */

export type BackendName = "WebGPU" | "WebGL2" | "unknown";

export interface RendererBundle {
  readonly renderer: WebGPURenderer;
  readonly canvas: HTMLCanvasElement;
  readonly backend: BackendName;
  /** True when ?gl forced the fallback, so the HUD can say so. */
  readonly forcedWebGL: boolean;
}

/** Shape-check rather than a cast: the base Backend type declares neither flag. */
function detectBackend(renderer: WebGPURenderer): BackendName {
  const backend: unknown = renderer.backend;
  if (typeof backend === "object" && backend !== null) {
    if ("isWebGPUBackend" in backend && backend.isWebGPUBackend === true) return "WebGPU";
    if ("isWebGLBackend" in backend && backend.isWebGLBackend === true) return "WebGL2";
  }
  return "unknown";
}

export async function createRenderer(canvas: HTMLCanvasElement): Promise<RendererBundle> {
  const forcedWebGL = new URLSearchParams(window.location.search).has("gl");

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    forceWebGL: forcedWebGL,
  });

  // Capped at 2: this is a chunky-voxel game with no thin geometry to
  // alias, so rendering 9x the pixels on a 3x-DPR display buys nothing and
  // costs most of the frame budget.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);

  // Must complete before any material compiles or any buffer uploads. This
  // async step is new versus the C++ (where GL context creation is
  // synchronous) and is the same ordering constraint Jolt's WASM init will
  // impose at M7.
  await renderer.init();

  return { renderer, canvas, backend: detectBackend(renderer), forcedWebGL };
}

/**
 * Keeps the drawing buffer matched to the CSS size. `updateStyle = false`
 * because CSS already sizes the canvas to 100%/100% -- letting three.js write
 * inline width/height would fight it.
 */
export function installResizeHandler(bundle: RendererBundle, onResize: (w: number, h: number) => void): void {
  const apply = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // A minimized window (or a display change) reports 0x0, and resizing the
    // drawing buffer to that makes the backend build zero-extent depth/colour
    // textures -- which on WebGPU is a stream of GPUValidationErrors rather
    // than a silent no-op. The C++ guards the same case in PostProcess via
    // its `captured_` flag (src/PostProcess.cpp). Keep the last good size.
    if (w === 0 || h === 0) return;
    bundle.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    bundle.renderer.setSize(w, h, false);
    onResize(w, h);
  };
  window.addEventListener("resize", apply);
  apply();
}
