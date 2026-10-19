/**
 * Minimal ambient types for the `fastnoise-lite` npm package, which ships
 * JSDoc but no .d.ts. Only the surface this project actually uses is
 * declared; widen it as more of the library gets used.
 */
declare module "fastnoise-lite" {
  export default class FastNoiseLite {
    constructor(seed?: number);

    static readonly NoiseType: {
      readonly OpenSimplex2: 0;
      readonly OpenSimplex2S: 1;
      readonly Cellular: 2;
      readonly Perlin: 3;
      readonly ValueCubic: 4;
      readonly Value: 5;
    };

    static readonly FractalType: {
      readonly None: 0;
      readonly FBm: 1;
      readonly Ridged: 2;
      readonly PingPong: 3;
      readonly DomainWarpProgressive: 4;
      readonly DomainWarpIndependent: 5;
    };

    SetSeed(seed: number): void;
    SetFrequency(frequency: number): void;
    SetNoiseType(noiseType: number): void;
    SetFractalType(fractalType: number): void;
    SetFractalOctaves(octaves: number): void;
    SetFractalLacunarity(lacunarity: number): void;
    SetFractalGain(gain: number): void;

    /** Returns noise in [-1, 1]. Omit `z` for 2D. */
    GetNoise(x: number, y: number, z?: number): number;
  }
}
