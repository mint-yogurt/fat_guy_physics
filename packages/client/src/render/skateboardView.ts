import { Group, type Scene } from "three/webgpu";

import type { LooseBoard } from "@fgp/shared/sim/looseBoard";
import type { Player } from "@fgp/shared/sim/player";
import { SKATE_BOARD_LENGTH } from "@fgp/shared/sim/skate";

import type { ItemAssets } from "./itemAssets.ts";

/**
 * The board under the rider's feet, in both camera views (the first-person
 * arm is a separate pass, so this lives in the world scene). It follows the
 * sim's board heading rather than the look direction, so a spin in the air or
 * a carve shows up as the board turning under you; a kickflip rolls it about
 * its long axis, and a manual tips its nose up about the back axle.
 */
export class SkateboardView {
  private readonly root = new Group();
  /** At the back axle: the manual's hinge. */
  private readonly hinge = new Group();
  /** At the board's middle: the kickflip's axis. */
  private readonly roll = new Group();

  constructor(
    private readonly scene: Scene,
    assets: ItemAssets,
  ) {
    const board = assets.skateboard.clone();
    board.position.y = -assets.skateboardHeight / 2;
    board.traverse((child) => {
      child.frustumCulled = false;
    });
    this.roll.position.set(SKATE_BOARD_LENGTH / 2, assets.skateboardHeight / 2, 0);
    this.roll.add(board);
    this.hinge.position.x = -SKATE_BOARD_LENGTH / 2;
    this.hinge.add(this.roll);
    this.root.add(this.hinge);
    this.root.visible = false;
    scene.add(this.root);
  }

  /** `underfoot` is false once the board has come off (a bail): nothing to draw. */
  update(player: Player, x: number, y: number, z: number, underfoot: boolean): void {
    this.root.visible = player.skating && underfoot;
    if (!this.root.visible) return;
    const { skate } = player;
    this.root.position.set(x, y, z);
    // Sim yaw is atan2(z, x); three's rotation about Y runs the other way.
    this.root.rotation.y = -skate.heading;
    this.hinge.rotation.z = skate.manual;
    this.roll.rotation.x = skate.flip;
  }

  dispose(): void {
    this.scene.remove(this.root);
  }
}

/**
 * Boards that have come off their riders and are rolling, tumbling or
 * sliding to a stop. Drawn between substeps like the player is.
 */
export class LooseBoardsView {
  private readonly roots: { root: Group; roll: Group }[] = [];
  private readonly height: number;

  constructor(
    private readonly scene: Scene,
    private readonly assets: ItemAssets,
  ) {
    this.height = assets.skateboardHeight;
  }

  private make(): { root: Group; roll: Group } {
    const board = this.assets.skateboard.clone();
    board.position.y = -this.height / 2;
    board.traverse((child) => {
      child.frustumCulled = false;
    });
    const roll = new Group();
    roll.position.y = this.height / 2;
    roll.add(board);
    const root = new Group();
    root.add(roll);
    this.scene.add(root);
    return { root, roll };
  }

  sync(boards: readonly LooseBoard[], alpha: number): void {
    for (let i = 0; i < Math.max(boards.length, this.roots.length); i++) {
      const board = boards[i];
      let entry = this.roots[i];
      if (board === undefined) {
        if (entry !== undefined) entry.root.visible = false;
        continue;
      }
      if (entry === undefined) {
        entry = this.make();
        this.roots.push(entry);
      }
      entry.root.visible = true;
      entry.root.position.set(
        board.prevX + (board.x - board.prevX) * alpha,
        board.prevY + (board.y - board.prevY) * alpha,
        board.prevZ + (board.z - board.prevZ) * alpha,
      );
      entry.root.rotation.y = -board.heading;
      entry.roll.rotation.x = board.flip;
    }
  }

  dispose(): void {
    for (const { root } of this.roots) this.scene.remove(root);
    this.roots.length = 0;
  }
}
