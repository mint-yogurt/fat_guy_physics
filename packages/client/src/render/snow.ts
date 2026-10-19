import {
  BufferAttribute,
  BufferGeometry,
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
    const corner = attribute("corner", "vec2");
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

    material.colorNode = vec3(0.97, 0.98, 1.0);
    // Round, soft-edged flakes, and the presence test that gates how many
    // of them exist at the current intensity.
    const disc = smoothstep(float(1), float(0.25), corner.length());
    material.opacityNode = disc.mul(step(presence, this.intensity)).mul(0.85);
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
