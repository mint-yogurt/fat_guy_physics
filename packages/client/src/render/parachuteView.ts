import { Group, Vector3, type Scene } from "three/webgpu";

import { XMAS_LIGHTS } from "@fgp/shared/items/rope";

import type { ParachuteAssets } from "./itemAssets.ts";
import { RopeChain, type RopeParts } from "./ropeView.ts";

/**
 * An open parachute: the canopy overhead and four strings of xmas lights running down from its
 * corners, the two on the left side meeting in the left hand and the two on the right in the right.
 * Each string is half the length of the real ones (the same mesh, with its lit bulbs).
 *
 * It is drawn in world space from three things: how full the canopy is (`Glide.open`), the way it
 * is heading, and where the hands are. The canopy hangs above the hands at the height at which the
 * lines are exactly their length, and grows from the hands as it fills.
 *
 * The caller says where the hands are: the third-person model's (PlayerModel.handWorld), or
 * stand-in points either side of the camera in first person, where the arm itself is not drawn.
 */

/** Length of one line, metres: half what a string of xmas lights reaches. */
export const CHUTE_LINE_LENGTH = (XMAS_LIGHTS.segments * XMAS_LIGHTS.maxSegmentLength) / 2;
/** Pieces a line is drawn in: about as far apart as the bulbs of a taut full-length string. */
const LINE_SEGMENTS = Math.round(CHUTE_LINE_LENGTH / XMAS_LIGHTS.maxSegmentLength);
/** Lines never hang shorter than this fraction of their length, so the canopy cannot sit on the hands. */
const MIN_HEIGHT = 0.3;

const corner = new Vector3();
const hand = new Vector3();
const middle = new Vector3();

export class ParachuteView {
  private readonly root = new Group();
  private readonly lines: RopeChain[] = [];
  private readonly points: Vector3[][] = [];
  private readonly corners: Vector3[] = [];

  constructor(
    scene: Scene,
    private readonly assets: ParachuteAssets,
    parts: RopeParts,
  ) {
    this.root.add(assets.canopy);
    this.root.visible = false;
    scene.add(this.root);
    for (let i = 0; i < 4; i++) {
      const line = new RopeChain(parts, LINE_SEGMENTS);
      line.root.visible = false;
      scene.add(line.root);
      this.lines.push(line);
      this.points.push(Array.from({ length: LINE_SEGMENTS + 1 }, () => new Vector3()));
      this.corners.push(new Vector3());
    }
  }

  /**
   * `open` is 0 (nothing drawn) to 1 (full); `heading` is the way it travels, radians, as the sim's
   * `atan2(z, x)`. `left` and `right` are the hands in world space.
   */
  update(open: number, heading: number, left: Vector3, right: Vector3): void {
    const shown = open > 0.01;
    this.root.visible = shown;
    for (const line of this.lines) line.root.visible = shown;
    if (!shown) return;

    const grown = open * open * (3 - 2 * open);
    middle.addVectors(left, right).multiplyScalar(0.5);
    this.root.rotation.y = -heading;
    this.root.scale.setScalar(Math.max(grown, 0.02));

    // The height at which the lines, from where they are tied to where they are held, are their length.
    this.root.position.set(middle.x, middle.y, middle.z);
    this.root.updateMatrixWorld(true);
    let reachSquared = 0;
    for (let i = 0; i < 4; i++) {
      const target = this.corners[i];
      const tie = this.assets.corners[i];
      if (target === undefined || tie === undefined) continue;
      target.copy(tie);
      this.root.localToWorld(target);
      const held = i < 2 ? left : right;
      reachSquared += (target.x - held.x) ** 2 + (target.z - held.z) ** 2;
    }
    const height = Math.max(
      Math.sqrt(Math.max(0, CHUTE_LINE_LENGTH * CHUTE_LINE_LENGTH - reachSquared / 4)),
      CHUTE_LINE_LENGTH * MIN_HEIGHT,
    );
    this.root.position.y = middle.y + height * grown;
    this.root.updateMatrixWorld(true);

    for (let i = 0; i < 4; i++) {
      const line = this.lines[i];
      const points = this.points[i];
      const tie = this.assets.corners[i];
      if (line === undefined || points === undefined || tie === undefined) continue;
      corner.copy(tie);
      this.root.localToWorld(corner);
      hand.copy(i < 2 ? left : right);
      for (let k = 0; k < points.length; k++) points[k]?.lerpVectors(hand, corner, k / LINE_SEGMENTS);
      // Bulbs face away from the canopy's axis, and a little down.
      line.along(points, (mid, out) => {
        out.set(mid.x - this.root.position.x, -0.35, mid.z - this.root.position.z).normalize();
      });
    }
  }

  /** Lights the ground and the player with the bulbs; call once the frame's lights are being gathered. */
  offerLights(): void {
    for (const line of this.lines) line.offerLights();
  }
}
