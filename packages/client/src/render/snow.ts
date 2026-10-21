import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshBasicNodeMaterial,
  Vector3,
  type Camera,
  type Scene,
} from "three/webgpu";
import { attribute, float, positionGeometry, smoothstep, step, uniform, vec3 } from "three/tsl";

/**
 * Falling snow for the Christmas region.
 *
 * One mesh, one draw call, and nothing written per frame except a handful of
 * uniforms: every flake's path is a closed-form function of time, so the
 * vertex buffer is built once at startup and never touched again. The
 * alternative -- integrating positions on the CPU and re-uploading -- is the
 * usual way a particle system like this ends up costing more than the
 * terrain it falls on.
 *
 * Flakes live in a box that follows the camera and wrap around modulo its
 * size, so a fixed few thousand of them cover any view distance. The wrap
 * happens in the shader, which is why the box can follow the camera without
 * flakes visibly jumping: wrapping is relative to the box, and the box's
 * origin is quantised to whole metres (see `update`) so the modulo lands in
 * the same place from frame to frame.
 */

/** Flake count. Enough to read as weather, cheap enough to ignore. */
const FLAKE_COUNT = 4000;

/** Box edge in metres. Wider than the blizzard fade distance, so the near
 * edge of the box is never visible during one. */
const BOX_SIZE = 70;

/** Metres per second, at calm and at full blizzard. */
const FALL_CALM = 1.6;
const FALL_BLIZZARD = 7;

/** Horizontal drift, metres per second. A blizzard is mostly sideways. */
const WIND_CALM = 0.35;
const WIND_BLIZZARD = 11;

/** Flake radius in metres. */
const SIZE_CALM = 0.045;
const SIZE_BLIZZARD = 0.07;

/** Corner offsets for two triangles, in units of flake radius. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, -1],
  [1, 1],
  [-1, 1],
] as const;

/** What a flake looks like, shared by the weather and anything that shakes snow loose. */
const FLAKE_COLOR = [0.97, 0.98, 1.0] as const;
const FLAKE_OPACITY = 0.85;

/** The soft round edge of a flake quad, from its corner coordinate (-1..1 each way). */
function flakeCorner() {
  return attribute("corner", "vec2");
}

function flakeDisc(corner: ReturnType<typeof flakeCorner>) {
  return smoothstep(float(1), float(0.25), corner.length());
}

export class Snow {
  private readonly mesh: Mesh;
  private readonly time = uniform(0);
  private readonly intensity = uniform(0);
  private readonly fall = uniform(FALL_CALM);
  private readonly windX = uniform(WIND_CALM);
  private readonly windZ = uniform(WIND_CALM * 0.5);
  private readonly size = uniform(SIZE_CALM);
  /** Camera basis, so a flake quad can face the viewer without a billboard
   * matrix per flake. Rebuilt from the camera each frame. */
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));

  constructor(scene: Scene) {
    const vertexCount = FLAKE_COUNT * CORNERS.length;
    // `position` holds the flake's seed point in 0..1 per axis rather than a
    // real position; positionNode below turns it into one. It stays the
    // `position` attribute because that is what gives the geometry its
    // vertex count.
    const seeds = new Float32Array(vertexCount * 3);
    const corners = new Float32Array(vertexCount * 2);
    const rand = new Float32Array(vertexCount);
    const rate = new Float32Array(vertexCount);

    for (let f = 0; f < FLAKE_COUNT; f++) {
      const sx = Math.random();
      const sy = Math.random();
      const sz = Math.random();
      // Which fraction of a storm this flake belongs to: flakes with a low
      // draw are present even in calm weather, the rest appear as the
      // intensity rises past them.
      const presence = Math.random();
      // Per-flake fall rate, so flakes don't descend in lockstep.
      const speed = 0.7 + Math.random() * 0.6;

      for (let c = 0; c < CORNERS.length; c++) {
        const v = f * CORNERS.length + c;
        seeds[v * 3] = sx;
        seeds[v * 3 + 1] = sy;
        seeds[v * 3 + 2] = sz;
        corners[v * 2] = CORNERS[c]?.[0] ?? 0;
        corners[v * 2 + 1] = CORNERS[c]?.[1] ?? 0;
        rand[v] = presence;
        rate[v] = speed;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(seeds, 3));
    geometry.setAttribute("corner", new BufferAttribute(corners, 2));
    geometry.setAttribute("rand", new BufferAttribute(rand, 1));
    geometry.setAttribute("rate", new BufferAttribute(rate, 1));

    const material = new MeshBasicNodeMaterial();
    const corner = flakeCorner();
    const presence = attribute("rand", "float");
    const rateAttr = attribute("rate", "float");

    const span = float(BOX_SIZE);
    const half = float(BOX_SIZE / 2);
    const seed = positionGeometry;

    // mod() rather than a CPU wrap: a flake that walks off one face of the
    // box reappears on the opposite one, which is what lets FLAKE_COUNT stay
    // fixed no matter how far the player travels.
    const driftX = seed.x.mul(span).add(this.windX.mul(this.time)).mod(span).sub(half);
    const driftZ = seed.z.mul(span).add(this.windZ.mul(this.time)).mod(span).sub(half);
    const drop = half.sub(
      seed.y.mul(span).add(this.fall.mul(rateAttr).mul(this.time)).mod(span),
    );

    const center = vec3(driftX, drop, driftZ);
    const offset = this.right
      .mul(corner.x.mul(this.size))
      .add(this.up.mul(corner.y.mul(this.size)));
    material.positionNode = center.add(offset);

    material.colorNode = vec3(...FLAKE_COLOR);
    // Round, soft-edged flakes, and the presence test that gates how many
    // of them exist at the current intensity.
    const disc = flakeDisc(corner);
    material.opacityNode = disc.mul(step(presence, this.intensity)).mul(FLAKE_OPACITY);
    material.transparent = true;
    material.depthWrite = false;
    material.fog = false;

    this.mesh = new Mesh(geometry, material);
    // The box is centred on the camera every frame, so three's own culling
    // test (which uses the geometry's bounding sphere around those 0..1
    // seed values) would be wrong in both directions.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /**
   * `intensity` is 0..1 overall snowfall, `blizzard` 0..1 how violent it is.
   * At intensity 0 the mesh is skipped entirely rather than drawn empty.
   */
  update(camera: Camera, elapsedSeconds: number, intensity: number, blizzard: number): void {
    this.mesh.visible = intensity > 0.001;
    if (!this.mesh.visible) return;

    this.time.value = elapsedSeconds;
    this.intensity.value = intensity;
    this.fall.value = FALL_CALM + (FALL_BLIZZARD - FALL_CALM) * blizzard;
    this.windX.value = WIND_CALM + (WIND_BLIZZARD - WIND_CALM) * blizzard;
    this.windZ.value = (WIND_CALM + (WIND_BLIZZARD - WIND_CALM) * blizzard) * 0.4;
    this.size.value = SIZE_CALM + (SIZE_BLIZZARD - SIZE_CALM) * blizzard;

    // Whole metres: the shader wraps flakes relative to the mesh origin, so
    // a continuously-moving origin would slide the whole snowfield with the
    // player. Quantising means it jumps by a metre at a time instead, which
    // at flake scale is invisible.
    this.mesh.position.set(
      Math.round(camera.position.x),
      Math.round(camera.position.y),
      Math.round(camera.position.z),
    );

    // Columns 0 and 1 of the camera's world matrix are its right and up.
    const m = camera.matrixWorld.elements;
    this.right.value.set(m[0] as number, m[1] as number, m[2] as number);
    this.up.value.set(m[4] as number, m[5] as number, m[6] as number);
  }
}

/** How a burst of flakes behaves and looks. Snow and crumbs are two styles of one machine. */
export interface BurstStyle {
  /** Most flakes alive at once across all bursts of this style. */
  readonly maxFlakes: number;
  /** Seconds a flake lives, and the last of that over which it shrinks away. */
  readonly life: number;
  readonly fade: number;
  /** m/s^2 down, and drag per second. */
  readonly gravity: number;
  readonly drag: number;
  /** Multiplies the weather's flake sizes. */
  readonly sizeScale: number;
  /** Soft round flakes (snow), or hard-edged squares (crumbs). */
  readonly round: boolean;
  readonly opacity: number;
  /** Fraction of its speed a flake keeps bouncing off the ground; 0 settles where it lands. Needs a `groundAt`. */
  readonly bounce: number;
}

/** Snow shaken loose: slower to fall than the rain of it overhead, and stopped dead quickly. */
export const SNOW_BURST: BurstStyle = {
  maxFlakes: 600,
  life: 1.1,
  fade: 0.35,
  gravity: 2.4,
  drag: 2.2,
  sizeScale: 1,
  round: true,
  opacity: FLAKE_OPACITY,
  bounce: 0,
};

/** Crumbs and sugar from something breaking: heavy, hard, bigger, and they skip off the ground. */
export const CRUMB_BURST: BurstStyle = {
  maxFlakes: 700,
  life: 1.5,
  fade: 0.4,
  gravity: 9,
  drag: 0.6,
  sizeScale: 2.4,
  round: false,
  opacity: 1,
  bounce: 0.35,
};

/** Fizz and slime from a burst can or a splatted ball of goo: hard-edged square chunks like the crumbs, heavy, hardly bouncing. */
export const GOO_BURST: BurstStyle = {
  maxFlakes: 900,
  life: 1.3,
  fade: 0.4,
  gravity: 10,
  drag: 0.9,
  sizeScale: 2.4,
  round: false,
  opacity: 1,
  bounce: 0.12,
};

interface Flake {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
}

/** A flake colour as the three numbers a material takes (linear), from a 0xRRGGBB. */
export function flakeRgb(hex: number): readonly [number, number, number] {
  const color = new Color(hex);
  return [color.r, color.g, color.b];
}

const SNOW_COLOR: readonly [number, number, number] = FLAKE_COLOR;

/**
 * Snow shaken loose: a burst of the very same flakes the weather is made of
 * (same quads, same soft round edge, same colour, same size), thrown out from
 * a point and settling. A snowman that is hit uses it. With a different
 * {@link BurstStyle} and colours the same flakes are crumbs: a gingerbread
 * house coming apart.
 *
 * Unlike the weather, whose flakes move by closed-form paths in the shader,
 * these are few and short lived, so they are integrated on the CPU and their
 * positions rewritten each frame (only while any are alive).
 */
export class SnowFlakeBurst {
  private readonly flakes: Flake[] = [];
  private readonly mesh: Mesh;
  private readonly centres: Float32Array;
  private readonly sizes: Float32Array;
  private readonly colours: Float32Array;
  private readonly positionAttribute: BufferAttribute;
  private readonly sizeAttribute: BufferAttribute;
  private readonly colourAttribute: BufferAttribute;
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));
  private next = 0;
  private alive = 0;

  constructor(
    scene: Scene,
    private readonly style: BurstStyle = SNOW_BURST,
  ) {
    const max = style.maxFlakes;
    const vertexCount = max * CORNERS.length;
    this.centres = new Float32Array(vertexCount * 3);
    this.sizes = new Float32Array(vertexCount);
    this.colours = new Float32Array(vertexCount * 3);
    const corners = new Float32Array(vertexCount * 2);
    for (let f = 0; f < max; f++) {
      this.flakes.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, size: 0 });
      for (let c = 0; c < CORNERS.length; c++) {
        const v = f * CORNERS.length + c;
        corners[v * 2] = CORNERS[c]?.[0] ?? 0;
        corners[v * 2 + 1] = CORNERS[c]?.[1] ?? 0;
        this.colours[v * 3] = SNOW_COLOR[0];
        this.colours[v * 3 + 1] = SNOW_COLOR[1];
        this.colours[v * 3 + 2] = SNOW_COLOR[2];
      }
    }

    const geometry = new BufferGeometry();
    this.positionAttribute = new BufferAttribute(this.centres, 3);
    this.sizeAttribute = new BufferAttribute(this.sizes, 1);
    this.colourAttribute = new BufferAttribute(this.colours, 3);
    this.positionAttribute.setUsage(DynamicDrawUsage);
    this.sizeAttribute.setUsage(DynamicDrawUsage);
    this.colourAttribute.setUsage(DynamicDrawUsage);
    geometry.setAttribute("position", this.positionAttribute);
    geometry.setAttribute("corner", new BufferAttribute(corners, 2));
    geometry.setAttribute("flakeSize", this.sizeAttribute);
    geometry.setAttribute("flakeColor", this.colourAttribute);

    const material = new MeshBasicNodeMaterial();
    const corner = flakeCorner();
    const size = attribute("flakeSize", "float");
    material.positionNode = positionGeometry
      .add(this.right.mul(corner.x.mul(size)))
      .add(this.up.mul(corner.y.mul(size)));
    material.colorNode = attribute("flakeColor", "vec3");
    material.opacityNode = style.round ? flakeDisc(corner).mul(style.opacity) : float(style.opacity);
    material.transparent = style.opacity < 1 || style.round;
    material.depthWrite = !material.transparent;
    material.fog = false;

    this.mesh = new Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /**
   * `count` flakes from (x, y, z), thrown out around the direction (nx, ny, nz)
   * at about `speed` m/s. Each takes a colour from `palette` at random; snow
   * if there is none.
   */
  burst(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    count: number,
    speed: number,
    palette: readonly (readonly [number, number, number])[] = [SNOW_COLOR],
  ): void {
    const max = this.style.maxFlakes;
    for (let i = 0; i < count; i++) {
      const at = this.next;
      const flake = this.flakes[at];
      this.next = (this.next + 1) % max;
      if (flake === undefined) continue;
      const spread = 0.9;
      const pace = speed * (0.35 + Math.random() * 0.9);
      flake.x = x;
      flake.y = y;
      flake.z = z;
      flake.vx = (nx + (Math.random() - 0.5) * 2 * spread) * pace;
      flake.vy = (ny + (Math.random() - 0.35) * 1.6 * spread) * pace;
      flake.vz = (nz + (Math.random() - 0.5) * 2 * spread) * pace;
      flake.life = this.style.life * (0.6 + Math.random() * 0.5);
      // The weather's own flake sizes.
      flake.size = (SIZE_CALM + Math.random() * (SIZE_BLIZZARD - SIZE_CALM)) * this.style.sizeScale;
      const colour = palette[Math.floor(Math.random() * palette.length)] ?? SNOW_COLOR;
      for (let c = 0; c < CORNERS.length; c++) {
        const v = (at * CORNERS.length + c) * 3;
        this.colours[v] = colour[0];
        this.colours[v + 1] = colour[1];
        this.colours[v + 2] = colour[2];
      }
    }
    this.colourAttribute.needsUpdate = true;
    this.alive = Math.min(max, this.alive + count);
  }

  /**
   * Moves the flakes on and turns the quads to face `camera`. With `groundAt`
   * (the terrain's height under a point) the flakes of a bouncing style land on
   * it instead of falling through.
   */
  update(camera: Camera, dt: number, groundAt?: (x: number, z: number) => number): void {
    if (this.alive === 0) {
      this.mesh.visible = false;
      return;
    }
    const { gravity, fade, bounce } = this.style;
    const drag = Math.max(0, 1 - this.style.drag * dt);
    let living = 0;
    for (let f = 0; f < this.style.maxFlakes; f++) {
      const flake = this.flakes[f] as Flake;
      let size = 0;
      if (flake.life > 0) {
        flake.life -= dt;
        flake.vx *= drag;
        flake.vy = flake.vy * drag - gravity * dt;
        flake.vz *= drag;
        flake.x += flake.vx * dt;
        flake.y += flake.vy * dt;
        flake.z += flake.vz * dt;
        if (bounce > 0 && groundAt !== undefined) {
          const floor = groundAt(flake.x, flake.z) + flake.size;
          if (flake.y < floor) {
            flake.y = floor;
            flake.vy = Math.abs(flake.vy) * bounce;
            flake.vx *= 0.6;
            flake.vz *= 0.6;
          }
        }
        if (flake.life > 0) {
          size = flake.size * Math.min(1, flake.life / fade);
          living++;
        }
      }
      for (let c = 0; c < CORNERS.length; c++) {
        const v = f * CORNERS.length + c;
        this.centres[v * 3] = flake.x;
        this.centres[v * 3 + 1] = flake.y;
        this.centres[v * 3 + 2] = flake.z;
        this.sizes[v] = size;
      }
    }
    this.alive = living;
    this.positionAttribute.needsUpdate = true;
    this.sizeAttribute.needsUpdate = true;
    this.mesh.visible = true;

    const m = camera.matrixWorld.elements;
    this.right.value.set(m[0] as number, m[1] as number, m[2] as number);
    this.up.value.set(m[4] as number, m[5] as number, m[6] as number);
  }
}
