import { Box3, Group, Mesh, Vector3, type Object3D } from "three/webgpu";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { faceOutward } from "./meshOrientation.ts";

/**
 * The item meshes, loaded once and cloned per use: on the ground, in the
 * hand, and in flight. Clones share geometry and materials, so a field of
 * a hundred sticks costs one stick's vertices.
 *
 * Every template is normalised into metres in a frame the rest of the code
 * can rely on without knowing the file:
 *
 *  - stick: the shaft runs along +Z, from the butt (the plain end, held in
 *    the hand) at z=0 to the fork (the business end) at z=STICK_LENGTH.
 *    That is how stick.glb is authored, at about 30 units long; its
 *    "attachment" node marks where the hand goes.
 *  - log: a cylinder along +Y, centred on the origin.
 */

/** Metres, butt to fork. The C++ build's voxel stick was 1.3m. */
export const STICK_LENGTH = 1.3;
/** Authored length of stick.glb along Z, units. */
const STICK_AUTHORED_LENGTH = 29.74;

/** How big a log reads on the ground, as a fraction of log.glb's 0.76m. */
const LOG_SCALE = 0.7;

export interface ItemAssets {
  /** Shaft along +Z, butt at the origin, in metres. */
  readonly stick: Object3D;
  /** Where the hand closes on the stick, metres from the butt along +Z. */
  readonly stickGrip: number;
  readonly log: Object3D;
  /** The log's length and radius in metres, as drawn. */
  readonly logLength: number;
  readonly logRadius: number;
}

/**
 * Wraps a file's scene so the wrapper's origin and scale are the normalised
 * frame, with the authored node transforms left alone underneath.
 */
function wrap(scene: Object3D, scale: number): Group {
  const outer = new Group();
  scene.scale.setScalar(scale);
  scene.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    faceOutward(object.geometry);
    object.castShadow = false;
  });
  outer.add(scene);
  return outer;
}

export async function loadItemAssets(): Promise<ItemAssets> {
  const loader = new GLTFLoader();
  const [stickFile, logFile] = await Promise.all([
    loader.loadAsync("/meshes/stick.glb"),
    loader.loadAsync("/meshes/log.glb"),
  ]);

  const stickScale = STICK_LENGTH / STICK_AUTHORED_LENGTH;
  const attachment = stickFile.scene.getObjectByName("attachment");
  const stick = wrap(stickFile.scene, stickScale);
  // A hand right on the butt would hide the end of the stick inside the
  // fist; a little way up it is how a stick is actually held.
  const stickGrip = Math.max(0.06, (attachment?.position.z ?? 0) * stickScale + 0.06);

  const log = wrap(logFile.scene, LOG_SCALE);
  const bounds = new Box3().setFromObject(log);
  const size = bounds.getSize(new Vector3());
  // Centred, whatever the file's origin is.
  const centre = bounds.getCenter(new Vector3());
  logFile.scene.position.sub(centre);

  return {
    stick,
    stickGrip,
    log,
    logLength: size.y,
    logRadius: Math.max(size.x, size.z) / 2,
  };
}
