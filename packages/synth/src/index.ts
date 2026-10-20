export { DEFAULT_PATCH, PATCH_FIELDS, clampPatch, decodePatch, encodePatch, type Patch } from "./patch.ts";
export {
  OSC_NAMES, PLUCK_NAMES, RESO_NAMES,
  envLength, envShape, envValue, pitchSemitones, renderPatch,
  type EnvShape, type RenderOptions,
} from "./dsp.ts";
export { SynthPlayer } from "./player.ts";
