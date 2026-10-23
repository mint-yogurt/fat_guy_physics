import {
  HalfFloatType,
  NearestFilter,
  NodeMaterial,
  QuadMesh,
  RenderTarget,
  Vector2,
  type Node,
  type WebGPURenderer,
} from "three/webgpu";
import { abs, floor, mix, mod, sRGBTransferEOTF, sRGBTransferOETF, step, texture, uniform, uv, vec4 } from "three/tsl";
import { LEVELS } from "./n64Dither.ts";
import {
  internalSize,
  pictureFill,
  viewAspect,
  type RenderSettings,
  type RenderSettingsStore,
} from "./renderSettings.ts";

/**
 * The N64 picture. The 3D scene is drawn small (240 lines by default) into a render target,
 * then this pass blows it up to the window with nearest sampling, so every game pixel is a crisp
 * block, and does what the console's output stage did on the way:
 *
 * - a light horizontal smear (the video interface's filtering of the 320-wide image),
 * - a cut to 5 bits per channel with an ordered dither (the 16-bit framebuffer).
 *
 * Everything in the DOM (HUD, hotbar and inventory icons) is drawn afterwards at full
 * resolution, so text and UI stay sharp.
 *
 * A picture that does not match the window's shape (the 4:3 / 16:9 options) is centred with
 * black bars; the camera's aspect follows `viewAspect`, not the window.
 */

/** How far the horizontal smear goes: 0 = none, 1 = a full 1-2-1 blur. */
const SMEAR = 0.55;
/** Set false to see the picture without the 5-bit dither. */
const DITHER = true;

export class LowResPass {
  private readonly target: RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material = new NodeMaterial();
  private readonly size = uniform(new Vector2(320, 240));
  private readonly texel = uniform(new Vector2(1 / 320, 0));
  private readonly fill = uniform(new Vector2(1, 1));
  private windowAspect = 16 / 9;
  private aspect = 16 / 9;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly store: RenderSettingsStore,
    /** Told the picture's aspect whenever it changes, for the camera. */
    private readonly onAspect: (aspect: number) => void,
  ) {
    this.target = new RenderTarget(320, 240, {
      type: HalfFloatType,
      depthBuffer: true,
      samples: 0,
      generateMipmaps: false,
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });

    this.material.fragmentNode = this.buildOutput();
    this.material.depthTest = false;
    this.material.depthWrite = false;
    this.material.toneMapped = false;
    this.quad = new QuadMesh(this.material);

    store.onChange(() => {
      this.layout();
    });
    this.layout();
  }

  /** Tells the pass the window's size (CSS pixels). */
  resize(width: number, height: number): void {
    this.windowAspect = width / Math.max(1, height);
    this.layout();
  }

  /** The picture's aspect ratio, which the camera should use. */
  get viewAspect(): number {
    return this.aspect;
  }

  get settings(): RenderSettings {
    return this.store.settings;
  }

  /** Everything drawn from here until `present` goes into the small picture. */
  begin(): void {
    this.renderer.setRenderTarget(this.target);
  }

  /** Scales the small picture up onto the canvas. */
  present(): void {
    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }

  private layout(): void {
    const { internalHeight, aspect } = this.store.settings;
    this.aspect = viewAspect(aspect, this.windowAspect);
    const { width, height } = internalSize(internalHeight, this.aspect);
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    this.size.value.set(width, height);
    this.texel.value.set(1 / width, 0);
    const fill = pictureFill(this.aspect, this.windowAspect);
    this.fill.value.set(fill.x, fill.y);
    this.onAspect(this.aspect);
  }

  private buildOutput() {
    // The window's uv, remapped so the picture sits in the middle; outside it is a black bar.
    const at = uv().sub(0.5).div(this.fill).add(0.5);
    const inside = step(0, at.x).mul(step(at.x, 1)).mul(step(0, at.y)).mul(step(at.y, 1));

    const left = texture(this.target.texture, at.sub(this.texel));
    const middle = texture(this.target.texture, at);
    const right = texture(this.target.texture, at.add(this.texel));
    const smeared = left.add(right).mul(0.25).add(middle.mul(0.5));
    const linear = mix(middle.rgb, smeared.rgb, SMEAR);

    if (!DITHER) return vec4((linear as Node<"vec3">).mul(inside), 1);

    // Cut to 5 bits in display (sRGB) space, with the ordered dither added first. The output
    // stage converts back to sRGB itself, so go there, cut, and come back.
    const pixel = floor(at.mul(this.size));
    const x0 = mod(pixel.x, 2);
    const x1 = mod(floor(pixel.x.div(2)), 2);
    const y0 = mod(pixel.y, 2);
    const y1 = mod(floor(pixel.y.div(2)), 2);
    // The 4x4 Bayer entry: same as bayer4() in n64Dither.ts.
    const bayer = abs(x0.sub(y0)).mul(2).add(y0).mul(4).add(abs(x1.sub(y1)).mul(2).add(y1));
    const threshold = bayer.add(0.5).div(16);
    const display = sRGBTransferOETF(linear) as Node<"vec3">;
    const cut = display.mul(LEVELS).add(threshold).floor().div(LEVELS) as Node<"vec3">;
    return vec4((sRGBTransferEOTF(cut) as Node<"vec3">).mul(inside), 1);
  }
}
