import type { PerspectiveCamera } from "three/webgpu";

import type { Player } from "@fgp/shared/sim/player";
import type { SolidQuery } from "@fgp/shared/sim/collision";
import { VOXEL_SIZE } from "@fgp/shared/sim/constants";

/**
 * Places the camera from the player's eye and look direction. Ports
 * src/Camera.{hpp,cpp}.
 *
 * First person sits exactly at the eye; third person orbits behind at a
 * fixed distance, pulled in by a terrain probe so it never clips through
 * solid ground.
 */

const THIRD_PERSON_COLLISION_MARGIN = 0.25;
const THIRD_PERSON_SAMPLE_STEP = 0.05;
const THIRD_PERSON_MIN_DISTANCE = 0.3;

export const CameraPerspective = {
  FirstPerson: 0,
  ThirdPerson: 1,
} as const;
export type CameraPerspective = (typeof CameraPerspective)[keyof typeof CameraPerspective];

/**
 * Walks a ray in small steps -- cheaper to write than a real DDA raycast,
 * and third-person distances are short enough that it does not matter --
 * returning how far it gets before hitting solid terrain.
 */
function clearDistance(
  query: SolidQuery,
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDistance: number,
): number {
  for (let t = THIRD_PERSON_SAMPLE_STEP; t <= maxDistance; t += THIRD_PERSON_SAMPLE_STEP) {
    const vx = Math.floor((originX + dirX * t) / VOXEL_SIZE);
    const vy = Math.floor((originY + dirY * t) / VOXEL_SIZE);
    const vz = Math.floor((originZ + dirZ * t) / VOXEL_SIZE);
    if (query.isSolid(vx, vy, vz)) {
      return Math.max(0, t - THIRD_PERSON_SAMPLE_STEP);
    }
  }
  return maxDistance;
}

export class PlayerCamera {
  perspective: CameraPerspective = CameraPerspective.FirstPerson;
  /** Matches the C++ Camera::fovDegrees. */
  fovDegrees = 90;
  thirdPersonDistance = 2.2;
  /** Extra field of view on top of fovDegrees, for a sense of speed. */
  fovBoost = 0;

  togglePerspective(): void {
    this.perspective =
      this.perspective === CameraPerspective.FirstPerson
        ? CameraPerspective.ThirdPerson
        : CameraPerspective.FirstPerson;
  }

  /**
   * @param renderY interpolated eye Y. Physics runs at a fixed 120Hz while
   * frames render at whatever the display does, so using the raw simulation
   * position makes a 60Hz frame show whichever substep happened to land
   * last -- visible as a fine vertical shimmer while walking. The caller
   * passes the interpolated position instead.
   */
  sync(
    camera: PerspectiveCamera,
    player: Player,
    query: SolidQuery,
    renderX: number,
    renderY: number,
    renderZ: number,
  ): void {
    const eyeX = renderX;
    const eyeY = renderY + player.eyeHeight;
    const eyeZ = renderZ;

    const fov = this.fovDegrees + this.fovBoost;
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    if (this.perspective === CameraPerspective.FirstPerson) {
      camera.position.set(eyeX, eyeY, eyeZ);
    } else {
      const clear = clearDistance(
        query,
        eyeX,
        eyeY,
        eyeZ,
        -player.frontX,
        -player.frontY,
        -player.frontZ,
        this.thirdPersonDistance,
      );
      const distance = Math.max(
        THIRD_PERSON_MIN_DISTANCE,
        clear - THIRD_PERSON_COLLISION_MARGIN,
      );
      camera.position.set(
        eyeX - player.frontX * distance,
        eyeY - player.frontY * distance,
        eyeZ - player.frontZ * distance,
      );
    }

    // A point in front of the eye, not the eye itself: lookAt needs a
    // non-degenerate eye/target pair, and third person needs somewhere
    // ahead of the player to actually look at.
    camera.lookAt(eyeX + player.frontX, eyeY + player.frontY, eyeZ + player.frontZ);
  }
}
