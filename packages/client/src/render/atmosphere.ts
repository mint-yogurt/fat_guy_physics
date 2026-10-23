import {
  Color,
  Fog,
  type DirectionalLight,
  type HemisphereLight,
  type Scene,
} from "three/webgpu";

import { CHUNK_METERS } from "@fgp/shared/sim/world";
import { createBiomeWeights, type BiomeWeights } from "@fgp/shared/worldgen/biome";

import type { TerrainMaterial } from "./terrainMaterial.ts";

/**
 * Sky, light level, distance fade and weather, driven by which biome the
 * player is standing in.
 *
 * Everything here is a weighted blend of per-biome presets rather than a
 * switch on the dominant biome, so walking from plain ground into a
 * Halloween region darkens gradually over the transition band the biome
 * field already blends the ground colour across. One source of truth for
 * where a region begins, used by both.
 *
 * Terrain is lit by hand in the voxel shader and ignores the scene's lights
 * entirely, so the light level has to be pushed to both: the uniforms for
 * terrain, the HemisphereLight/DirectionalLight pair for the player model and
 * anything else using a lit material.
 */

interface Preset {
  /** Sky, and what distant terrain fades to. */
  readonly sky: number;
  /** Ground-shader light levels. */
  readonly ambient: number;
  readonly sun: number;
  /** Multiplier on the scene lights, which light the player model. */
  readonly lights: number;
  /** Fraction of the load radius at which the fade completes. */
  readonly fogFar: number;
  /** Steady-state snowfall, before any blizzard. */
  readonly snow: number;
}

/** Where the fog starts, as a fraction of where it completes. Low = the near-sighted N64 look. */
const FOG_NEAR_FRACTION = 0.25;

const PLAIN: Preset = {
  sky: 0x87b8dc, // the C++ clear colour (0.53, 0.72, 0.86)
  ambient: 0.55,
  sun: 0.65,
  lights: 1,
  fogFar: 0.8,
  snow: 0,
};

const CHRISTMAS: Preset = {
  // Paler and colder than plain daylight, which is most of what sells snow.
  sky: 0xc8d8e8,
  ambient: 0.68,
  sun: 0.5,
  lights: 1.05,
  fogFar: 0.75,
  snow: 0.35,
};

const HALLOWEEN: Preset = {
  // Spooky night: dark blue-violet, and dim enough to feel like night
  // without going so dark the terrain stops being readable. DESIGN's note is
  // "dark like its night but can still see".
  sky: 0x0e1020,
  ambient: 0.16,
  sun: 0.12,
  lights: 0.3,
  fogFar: 0.55,
  snow: 0,
};

/**
 * Blizzard schedule. Deterministic in elapsed time rather than random, so it
 * is reproducible when something looks wrong, and so the server can agree
 * with the client about the weather at M14 by sending nothing at all.
 */
const BLIZZARD_PERIOD = 300;
const BLIZZARD_LENGTH = 100;
const BLIZZARD_RAMP = 18;
/**
 * Seconds into each cycle before a blizzard starts. Non-zero so the game
 * does not open in the middle of one -- calm snowfall is the Christmas
 * region's normal weather, and a blizzard should be a thing that arrives.
 */
const BLIZZARD_START = 150;

/** What a full blizzard does on top of the Christmas preset. */
const BLIZZARD_SKY = 0xb4bcc4;
const BLIZZARD_FOG_METERS = 11;
const BLIZZARD_LIGHT_SCALE = 0.75;

/** 0..1 blizzard strength at a point in the cycle. */
export function blizzardAt(elapsedSeconds: number): number {
  const phase = (elapsedSeconds % BLIZZARD_PERIOD) - BLIZZARD_START;
  if (phase < 0 || phase >= BLIZZARD_LENGTH) return 0;
  const rampIn = Math.min(1, phase / BLIZZARD_RAMP);
  const rampOut = Math.min(1, (BLIZZARD_LENGTH - phase) / BLIZZARD_RAMP);
  return Math.min(rampIn, rampOut);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Atmosphere {
  private readonly weights: BiomeWeights = createBiomeWeights();
  private readonly skyColors = [
    new Color(PLAIN.sky),
    new Color(CHRISTMAS.sky),
    new Color(HALLOWEEN.sky),
  ];
  private readonly blizzardSky = new Color(BLIZZARD_SKY);
  private readonly sky = new Color(PLAIN.sky);
  private readonly loadRadiusMeters: number;
  private readonly fog: Fog;

  /** Last computed values, for the HUD and for the snow system. */
  snowIntensity = 0;
  blizzard = 0;

  constructor(
    private readonly scene: Scene,
    private readonly ground: TerrainMaterial,
    private readonly hemisphere: HemisphereLight,
    private readonly sun: DirectionalLight,
    loadRadiusChunks: number,
    private readonly hemisphereBase = hemisphere.intensity,
    private readonly sunBase = sun.intensity,
  ) {
    this.loadRadiusMeters = loadRadiusChunks * CHUNK_METERS;
    scene.background = this.sky;
    // Scene fog is for the lit meshes -- trees, logs, the player -- which
    // have no hand-rolled fade of their own, and without it a tree stays
    // sharp against terrain that has already faded into the sky. The ground
    // material opts out so its own fade is not applied twice.
    this.fog = new Fog(this.sky, 0, this.loadRadiusMeters);
    scene.fog = this.fog;
    ground.material.fog = false;
  }

  /**
   * `weights` are sampled by the caller from the world, so this never needs
   * the World itself. Called once per frame; allocates nothing.
   */
  update(weights: BiomeWeights, elapsedSeconds: number): void {
    const { plain, christmas, halloween } = weights;

    // A blizzard only exists where it is snowing, so its strength is scaled
    // by how far into the Christmas region the player is -- otherwise the
    // sky would grey out in regions that have no snow in them.
    const blizzard = blizzardAt(elapsedSeconds) * christmas;
    this.blizzard = blizzard;
    this.snowIntensity = christmas * (CHRISTMAS.snow + (1 - CHRISTMAS.snow) * blizzard);

    this.blendSky(plain, christmas, halloween);
    this.sky.lerp(this.blizzardSky, blizzard);

    const ambient = lerp(
      PLAIN.ambient * plain + CHRISTMAS.ambient * christmas + HALLOWEEN.ambient * halloween,
      CHRISTMAS.ambient * BLIZZARD_LIGHT_SCALE,
      blizzard,
    );
    const sunLevel = lerp(
      PLAIN.sun * plain + CHRISTMAS.sun * christmas + HALLOWEEN.sun * halloween,
      CHRISTMAS.sun * BLIZZARD_LIGHT_SCALE,
      blizzard,
    );
    const lights = lerp(
      PLAIN.lights * plain + CHRISTMAS.lights * christmas + HALLOWEEN.lights * halloween,
      CHRISTMAS.lights * BLIZZARD_LIGHT_SCALE,
      blizzard,
    );

    const fogFarFraction =
      PLAIN.fogFar * plain + CHRISTMAS.fogFar * christmas + HALLOWEEN.fogFar * halloween;
    const fogFar = lerp(this.loadRadiusMeters * fogFarFraction, BLIZZARD_FOG_METERS, blizzard);

    this.ground.ambient.value = ambient;
    this.ground.sun.value = sunLevel;
    this.ground.fogColor.value.copy(this.sky);
    // N64 fog: a short, early fade. Starting it much closer than this
    // whites out the ground the player is standing on, which in a snow
    // region means a whiteout in calm weather.
    this.ground.fogNear.value = fogFar * FOG_NEAR_FRACTION;
    this.ground.fogFar.value = fogFar;
    this.fog.color.copy(this.sky);
    this.fog.near = fogFar * FOG_NEAR_FRACTION;
    this.fog.far = fogFar;

    this.hemisphere.intensity = this.hemisphereBase * lights;
    this.sun.intensity = this.sunBase * lights;
    this.scene.background = this.sky;
  }

  /** Weighted mix of the three sky colours into `this.sky`, in place. */
  private blendSky(plain: number, christmas: number, halloween: number): void {
    const p = this.skyColors[0] as Color;
    const c = this.skyColors[1] as Color;
    const h = this.skyColors[2] as Color;
    this.sky.setRGB(
      p.r * plain + c.r * christmas + h.r * halloween,
      p.g * plain + c.g * christmas + h.g * halloween,
      p.b * plain + c.b * christmas + h.b * halloween,
    );
  }

  /** The weights buffer the caller should fill and hand back to `update`. */
  get weightsBuffer(): BiomeWeights {
    return this.weights;
  }
}
