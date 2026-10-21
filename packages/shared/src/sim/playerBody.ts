import {
  boxPushOut,
  spherePushOut,
  type ElasticBounds,
  type ElasticCollider,
  type ElasticVec,
} from "./elastic.ts";
import { PLAYER_MASS, PlayerMode, WALK_HEIGHT, type Player } from "./player.ts";

/** Something lying lower than this is stepped over, not walked into, metres. */
const STEP_OVER = 0.3;

/**
 * The player as something elastic things push against: the walking hitbox as
 * the box it is, the ragball as the sphere it is.
 */
export class PlayerBody implements ElasticCollider {
  readonly mass = PLAYER_MASS;

  constructor(private readonly player: Player) {}

  private get ragball(): boolean {
    return this.player.mode === PlayerMode.Ragball;
  }

  bounds(out: ElasticBounds): boolean {
    const p = this.player;
    const radius = this.ragball ? p.ballRadius : Math.hypot(p.halfWidth, WALK_HEIGHT / 2);
    out.x = p.x;
    out.y = p.y + (this.ragball ? p.ballRadius : WALK_HEIGHT / 2);
    out.z = p.z;
    out.radius = radius;
    return true;
  }

  pushOut(x: number, y: number, z: number, radius: number, out: ElasticVec): boolean {
    const p = this.player;
    if (y + radius < p.y + STEP_OVER) return false;
    if (this.ragball) {
      return spherePushOut(p.x, p.y + p.ballRadius, p.z, p.ballRadius, x, y, z, radius, out);
    }
    return boxPushOut(
      p.x - p.halfWidth,
      p.y,
      p.z - p.halfWidth,
      p.x + p.halfWidth,
      p.y + WALK_HEIGHT,
      p.z + p.halfWidth,
      x,
      y,
      z,
      radius,
      out,
    );
  }

  velocity(out: ElasticVec): void {
    out.x = this.player.vx;
    out.y = this.player.vy;
    out.z = this.player.vz;
  }

  push(ix: number, iy: number, iz: number): void {
    this.player.applyImpulse(ix, iy, iz);
  }
}
