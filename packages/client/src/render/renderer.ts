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
    // No MSAA: the 3D scene is drawn small by LowResPass (n64Pass.ts) and
    // blown up with nearest sampling, so edge smoothing would only soften
    // the blocks. What reaches the canvas is a flat quad and the DOM-aligned
    // hotbar icons.
    antialias: false,
    forceWebGL: forcedWebGL,
  });

  // Capped at 2: the canvas only needs to be sharp enough to show the low-res
  // picture's blocks cleanly, so 9x the pixels on a 3x-DPR display buys nothing.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  // Floored at 1x1: a tab that has not been laid out yet (freshly opened, or
  // opened in the background) reports innerWidth/innerHeight of 0, and
  // building the swapchain at that size is a hard WebGPU validation error,
  // not a silent no-op. See isRenderable() for the matching per-frame guard.
  renderer.setSize(Math.max(1, window.innerWidth), Math.max(1, window.innerHeight), false);

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
    // A minimized window, a not-yet-laid-out tab, or a display change
    // reports 0x0. Resizing the drawing buffer to that makes the backend
    // build zero-extent depth/colour textures, which on WebGPU is a stream
    // of GPUValidationErrors rather than a silent no-op. Keep the last good
    // size instead. The C++ guards the same case in PostProcess via its
    // `captured_` flag (src/PostProcess.cpp).
    if (w === 0 || h === 0) return;
    bundle.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    bundle.renderer.setSize(w, h, false);
    onResize(w, h);
  };
  window.addEventListener("resize", apply);
  apply();
}

/**
 * Whether it is safe to render this frame.
 *
 * The resize handler keeps the drawing buffer at its last good size when the
 * viewport collapses, but the swapchain texture itself still comes from the
 * canvas, so presenting into a 0x0 canvas fails regardless. Skipping the
 * frame entirely is the only thing that actually avoids it -- and a window
 * with no area has nothing to show anyway.
 */
export function isRenderable(): boolean {
  return window.innerWidth > 0 && window.innerHeight > 0;
}
