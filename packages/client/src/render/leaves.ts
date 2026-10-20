import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Mesh,
  MeshBasicNodeMaterial,
  NearestFilter,
  SRGBColorSpace,
  Vector3,
  type Camera,
  type Scene,
  type Texture,
} from "three/webgpu";
import {
  attribute,
  cos,
  float,
  floor,
  positionGeometry,
  sin,
  step,
  texture,
  uniform,
  vec2,
} from "three/tsl";

/**
 * Falling leaves for the Halloween region.
 *
 * Unlike the snow, these have to meet the ground -- a leaf disappears when it
 * lands -- and the ground is a noise function, not something a shader can
 * evaluate. So the motion is simulated on the CPU (a few hundred leaves is
 * nothing) and the positions are re-uploaded each frame; the look of a leaf
 * (which frame, how it tilts) is still a pure function of time in the shader.
 *
 * Leaves live in a square around the camera. One that walks out of it is
 * wrapped to the opposite side, so a fixed count covers any distance travelled.
 */

/** Leaf count at full Halloween weight. */
const LEAF_COUNT = 400;

/** Half-width of the square around the camera, metres. */
const RANGE = 28;

/** Spawn height above the higher of the ground and the camera, metres. */
const SPAWN_HEIGHT = 12;

/** Fall speed, metres per second, before the flutter modulates it. */
const FALL_SPEED = 1.15;

/** Steady drift in metres per second. */
const WIND_X = 0.45;
const WIND_Z = 0.25;

/** Side-to-side flutter: swing half-width in metres, and swings per second. */
const SWAY_MIN = 0.35;
const SWAY_MAX = 0.8;
const OMEGA_MIN = 2.2;
const OMEGA_MAX = 3.6;

/** Half the leaf's width in metres. */
const LEAF_RADIUS = 0.13;

/** Frames per second of the 4-frame sprite loop. */
const ANIMATION_FPS = 5;

/** Seconds over which a freshly placed leaf fades in. Hides the pop at the
 * edge of the box and at the spawn height. */
const FADE_IN = 0.7;

/** The ground is looked up for one leaf in this many frames. A leaf moves a
 * few centimetres in that time, and terrain noise is the expensive part. */
const GROUND_STRIDE = 4;

/** Largest step the simulation takes, so a stalled tab does not teleport
 * every leaf. */
const MAX_DT = 0.1;

/** Corner offsets for a quad, in units of leaf radius. */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
] as const;

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Wraps `offset` into [-RANGE, RANGE). */
function wrap(offset: number): number {
  const span = RANGE * 2;
  return ((((offset + RANGE) % span) + span) % span) - RANGE;
}

export class Leaves {
  private readonly mesh: Mesh;
  private readonly time = uniform(0);
  private readonly intensity = uniform(0);
  private readonly right = uniform(new Vector3(1, 0, 0));
  private readonly up = uniform(new Vector3(0, 1, 0));

  private readonly centers = new Float32Array(LEAF_COUNT * 4 * 3);
  private readonly fades = new Float32Array(LEAF_COUNT * 4);
  private readonly centerAttribute: BufferAttribute;
  private readonly fadeAttribute: BufferAttribute;

  /** Per-leaf simulation state. */
  private readonly x = new Float32Array(LEAF_COUNT);
  private readonly y = new Float32Array(LEAF_COUNT);
  private readonly z = new Float32Array(LEAF_COUNT);
  private readonly ground = new Float32Array(LEAF_COUNT);
  private readonly age = new Float32Array(LEAF_COUNT);

  /** Per-leaf constants. The shader reads omega/phase too, so the tilt it
   * draws stays in step with the sway simulated here. */
  private readonly omega = new Float32Array(LEAF_COUNT);
  private readonly phase = new Float32Array(LEAF_COUNT);
  private readonly sway = new Float32Array(LEAF_COUNT);
  private readonly swayX = new Float32Array(LEAF_COUNT);
  private readonly swayZ = new Float32Array(LEAF_COUNT);

  private frame = 0;
  /** True while hidden, so the leaves are scattered afresh on return rather
   * than resuming wherever they were left. */
  private stale = true;

  /**
   * `groundAt` returns the height in metres of the top of the terrain at a
   * world position in metres.
   */
  constructor(
    scene: Scene,
    map: Texture,
    private readonly groundAt: (x: number, z: number) => number,
  ) {
    // Pixel art: no smoothing between texels, and no mips bleeding the
    // neighbouring frame's colours across the cell boundary.
    map.magFilter = NearestFilter;
    map.minFilter = NearestFilter;
    map.generateMipmaps = false;
    map.colorSpace = SRGBColorSpace;

    const vertexCount = LEAF_COUNT * 4;
    const corners = new Float32Array(vertexCount * 2);
    const flutter = new Float32Array(vertexCount * 2);
    const presence = new Float32Array(vertexCount);
    const animOffset = new Float32Array(vertexCount);
    const indices = new Uint32Array(LEAF_COUNT * 6);

    for (let i = 0; i < LEAF_COUNT; i++) {
      this.omega[i] = between(OMEGA_MIN, OMEGA_MAX);
      this.phase[i] = Math.random() * Math.PI * 2;
      this.sway[i] = between(SWAY_MIN, SWAY_MAX);
      const heading = Math.random() * Math.PI * 2;
      this.swayX[i] = Math.cos(heading);
      this.swayZ[i] = Math.sin(heading);

      // Which fraction of the region's leaves this one belongs to: low draws
      // are there at the region's edge, the rest only deeper in.
      const draw = Math.random();
      const offset = Math.random() * 4;
      for (let c = 0; c < 4; c++) {
        const v = i * 4 + c;
        corners[v * 2] = CORNERS[c]?.[0] ?? 0;
        corners[v * 2 + 1] = CORNERS[c]?.[1] ?? 0;
        flutter[v * 2] = this.omega[i] as number;
        flutter[v * 2 + 1] = this.phase[i] as number;
        presence[v] = draw;
        animOffset[v] = offset;
      }
      indices.set([0, 1, 2, 0, 2, 3].map((n) => i * 4 + n), i * 6);
    }

    this.centerAttribute = new BufferAttribute(this.centers, 3);
    this.fadeAttribute = new BufferAttribute(this.fades, 1);
    this.centerAttribute.setUsage(DynamicDrawUsage);
    this.fadeAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", this.centerAttribute);
    geometry.setAttribute("corner", new BufferAttribute(corners, 2));
    geometry.setAttribute("flutter", new BufferAttribute(flutter, 2));
    geometry.setAttribute("rand", new BufferAttribute(presence, 1));
    geometry.setAttribute("animOffset", new BufferAttribute(animOffset, 1));
    geometry.setAttribute("fade", this.fadeAttribute);
    geometry.setIndex(new BufferAttribute(indices, 1));

    const material = new MeshBasicNodeMaterial();
    const corner = attribute("corner", "vec2");
    const flutterAttr = attribute("flutter", "vec2");
    const draw = attribute("rand", "float");
    const offsetAttr = attribute("animOffset", "float");
    const fade = attribute("fade", "float");

    // Tilt follows the sideways velocity -- zero at the end of a swing,
    // steepest through the middle -- and the corner offset is rotated by it.
    const roll = cos(flutterAttr.x.mul(this.time).add(flutterAttr.y)).mul(0.8);
    const c = cos(roll);
    const s = sin(roll);
    const rx = corner.x.mul(c).sub(corner.y.mul(s));
    const ry = corner.x.mul(s).add(corner.y.mul(c));
    material.positionNode = positionGeometry
      .add(this.right.mul(rx.mul(LEAF_RADIUS)))
      .add(this.up.mul(ry.mul(LEAF_RADIUS)));

    // Frame n of the 2x2 sheet: column n%2, row floor(n/2) counted from the
    // top. Texture v runs bottom-up, hence the 1 - ... on y.
    const frame = floor(this.time.mul(ANIMATION_FPS).add(offsetAttr)).mod(4);
    const col = frame.mod(2);
    const row = floor(frame.div(2));
    const local = corner.mul(0.5).add(0.5);
    const uvNode = vec2(
      col.add(local.x).mul(0.5),
      float(1).sub(row.add(float(1).sub(local.y)).mul(0.5)),
    );
    const sampled = texture(map, uvNode);

    material.colorNode = sampled.rgb;
    material.opacityNode = sampled.a.mul(fade).mul(step(draw, this.intensity));
    material.transparent = true;
    material.depthWrite = false;

    this.mesh = new Mesh(geometry, material);
    // Positions are written in world space and move every frame; the
    // bounding sphere three would compute from the first upload is wrong.
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
  }

  /**
   * `intensity` is 0..1, how much of the Halloween region the camera is in.
   * At 0 the mesh is skipped and nothing is simulated.
   */
  update(camera: Camera, elapsedSeconds: number, dt: number, intensity: number): void {
    this.mesh.visible = intensity > 0.001;
    if (!this.mesh.visible) {
      this.stale = true;
      return;
    }

    const cx = camera.position.x;
    const cy = camera.position.y;
    const cz = camera.position.z;

    if (this.stale) {
      for (let i = 0; i < LEAF_COUNT; i++) this.place(i, cx, cy, cz, true);
      this.stale = false;
    }

    this.time.value = elapsedSeconds;
    this.intensity.value = intensity;
    this.frame++;

    const stepSeconds = Math.min(dt, MAX_DT);
    for (let i = 0; i < LEAF_COUNT; i++) {
      this.advance(i, elapsedSeconds, stepSeconds, cx, cy, cz);
    }
    this.centerAttribute.needsUpdate = true;
    this.fadeAttribute.needsUpdate = true;

    // Columns 0 and 1 of the camera's world matrix are its right and up.
    const m = camera.matrixWorld.elements;
    this.right.value.set(m[0] as number, m[1] as number, m[2] as number);
    this.up.value.set(m[4] as number, m[5] as number, m[6] as number);
  }

  private advance(
    i: number,
    t: number,
    dt: number,
    cx: number,
    cy: number,
    cz: number,
  ): void {
    const omega = this.omega[i] as number;
    const arg = omega * t + (this.phase[i] as number);
    const swing = Math.cos(arg);

    // Sideways speed is the derivative of a sine of amplitude `sway`, and the
    // leaf falls fastest through the middle of a swing, where it is moving
    // sideways fastest, and hangs at the ends.
    const lateral = (this.sway[i] as number) * omega * swing;
    const fall = FALL_SPEED * (0.5 + 0.7 * swing * swing);

    let x = (this.x[i] as number) + (WIND_X + lateral * (this.swayX[i] as number)) * dt;
    let z = (this.z[i] as number) + (WIND_Z + lateral * (this.swayZ[i] as number)) * dt;
    const y = (this.y[i] as number) - fall * dt;

    this.age[i] = (this.age[i] as number) + dt;

    const dx = x - cx;
    const dz = z - cz;
    if (dx < -RANGE || dx >= RANGE || dz < -RANGE || dz >= RANGE) {
      x = cx + wrap(dx);
      z = cz + wrap(dz);
      this.x[i] = x;
      this.z[i] = z;
      this.y[i] = y;
      this.ground[i] = this.groundAt(x, z);
      this.age[i] = 0;
    } else {
      this.x[i] = x;
      this.z[i] = z;
      this.y[i] = y;
      if ((i + this.frame) % GROUND_STRIDE === 0) this.ground[i] = this.groundAt(x, z);
    }

    // Landed: gone, and a replacement starts again at the top.
    if (y <= (this.ground[i] as number)) {
      this.place(i, cx, cy, cz, false);
      return;
    }
    this.write(i);
  }

  /**
   * Puts leaf `i` somewhere in the box. `anywhere` scatters it through the
   * whole column between the ground and the spawn height, for the first fill;
   * otherwise it starts near the top and falls the whole way.
   */
  private place(i: number, cx: number, cy: number, cz: number, anywhere: boolean): void {
    const x = cx + between(-RANGE, RANGE);
    const z = cz + between(-RANGE, RANGE);
    const ground = this.groundAt(x, z);
    const top = Math.max(ground, cy) + SPAWN_HEIGHT;
    this.x[i] = x;
    this.z[i] = z;
    this.ground[i] = ground;
    this.y[i] = anywhere ? between(ground + 0.2, top) : top - Math.random() * 2;
    this.age[i] = anywhere ? FADE_IN : 0;
    this.write(i);
  }

  private write(i: number): void {
    const fade = Math.min(1, (this.age[i] as number) / FADE_IN);
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      this.centers[v * 3] = this.x[i] as number;
      this.centers[v * 3 + 1] = this.y[i] as number;
      this.centers[v * 3 + 2] = this.z[i] as number;
      this.fades[v] = fade;
    }
  }
}
