import { Vector4, type MeshLambertNodeMaterial } from "three/webgpu";
import {
  diffuseColor,
  dot,
  float,
  Fn,
  int,
  inverseSqrt,
  Loop,
  max,
  normalWorld,
  positionWorld,
  uniform,
  uniformArray,
  vec3,
} from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * Light thrown by xmas light bulbs onto what is round them: the ground, trees,
 * props, players. Not three's lights (each of those costs every lit material
 * a shader recompile and a shadow-free loop anyway), but a small pool of
 * point glows shared by every material through one set of uniforms:
 *
 *  - each frame the bulbs nearest the eye are picked, up to MAX_BULB_LIGHTS;
 *  - a material adds `bulbGlow(position, normal)` times its own colour on top
 *    of whatever light it already had, so a pool of red/green/blue spreads
 *    over the snow under a string and fades out round it.
 *
 * The falloff is soft and wraps round the side away from the bulb, as N64
 * vertex lighting did, rather than a hard-edged physical light. It is
 * additive, so it reads most at night and barely by day, like the real thing.
 */

/** How many bulbs light the world at once; the rest only glow themselves. */
export const MAX_BULB_LIGHTS = 32;
/** Metres from a bulb at which its light has faded to nothing. */
export const BULB_LIGHT_RADIUS = 1.8;
/** How bright a bulb's light is right next to it, as a multiple of its colour. */
export const BULB_LIGHT_INTENSITY = 0.85;
/** Bulbs further than this from the eye light nothing (the fog has them anyway). */
const BULB_LIGHT_RANGE = 45;

/** Picks the nearest few of many points, without allocating. */
export class NearestLights {
  count = 0;
  readonly distanceSq: Float64Array;
  /** x, y, z, r, g, b per light, nearest first. */
  readonly data: Float32Array;
  private cx = 0;
  private cy = 0;
  private cz = 0;

  constructor(
    readonly capacity: number,
    private readonly range: number,
  ) {
    this.distanceSq = new Float64Array(capacity);
    this.data = new Float32Array(capacity * 6);
  }

  begin(cx: number, cy: number, cz: number): void {
    this.count = 0;
    this.cx = cx;
    this.cy = cy;
    this.cz = cz;
  }

  offer(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const dz = z - this.cz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d > this.range * this.range) return;
    let i = this.count;
    if (i === this.capacity) {
      if (d >= (this.distanceSq[i - 1] ?? 0)) return;
      i--;
    } else {
      this.count++;
    }
    // Shift the further ones down one and drop this one in, keeping the order.
    const { distanceSq, data } = this;
    while (i > 0 && (distanceSq[i - 1] ?? 0) > d) {
      distanceSq[i] = distanceSq[i - 1] ?? 0;
      data.copyWithin(i * 6, (i - 1) * 6, i * 6);
      i--;
    }
    distanceSq[i] = d;
    data[i * 6] = x;
    data[i * 6 + 1] = y;
    data[i * 6 + 2] = z;
    data[i * 6 + 3] = r;
    data[i * 6 + 4] = g;
    data[i * 6 + 5] = b;
  }
}

const positions = Array.from({ length: MAX_BULB_LIGHTS }, () => new Vector4());
const colors = Array.from({ length: MAX_BULB_LIGHTS }, () => new Vector4());
/** xyz = where, w = 1 / radius². */
const positionsNode = uniformArray<"vec4">(positions, "vec4");
/** rgb = colour times intensity. */
const colorsNode = uniformArray<"vec4">(colors, "vec4");
const countNode = uniform(0, "int");

const nearest = new NearestLights(MAX_BULB_LIGHTS, BULB_LIGHT_RANGE);

/** Each frame: begin at the eye, offer every bulb, then commit. */
export const bulbLights = {
  begin(eyeX: number, eyeY: number, eyeZ: number): void {
    nearest.begin(eyeX, eyeY, eyeZ);
  },
  offer(
    x: number,
    y: number,
    z: number,
    r: number,
    g: number,
    b: number,
  ): void {
    nearest.offer(x, y, z, r, g, b);
  },
  commit(): void {
    const { data, count } = nearest;
    const inverseRadiusSq = 1 / (BULB_LIGHT_RADIUS * BULB_LIGHT_RADIUS);
    for (let i = 0; i < count; i++) {
      const o = i * 6;
      positions[i]?.set(
        data[o] ?? 0,
        data[o + 1] ?? 0,
        data[o + 2] ?? 0,
        inverseRadiusSq,
      );
      colors[i]?.set(
        (data[o + 3] ?? 0) * BULB_LIGHT_INTENSITY,
        (data[o + 4] ?? 0) * BULB_LIGHT_INTENSITY,
        (data[o + 5] ?? 0) * BULB_LIGHT_INTENSITY,
        0,
      );
    }
    countNode.value = count;
  },
};

/** The bulbs' light arriving at a world point with a world normal, as an rgb multiplier. */
export const bulbGlow = Fn(
  ([position, normal]: [Node<"vec3">, Node<"vec3">]) => {
    const total = vec3(0).toVar();
    Loop(
      { start: int(0), end: countNode, type: "int", condition: "<" },
      ({ i }) => {
        const light = positionsNode.element(i);
        const toLight = light.xyz.sub(position);
        const distanceSq = dot(toLight, toLight);
        const fade = max(float(1).sub(distanceSq.mul(light.w)), 0);
        // Half-Lambert: lit all round, brightest facing the bulb.
        const facing = dot(
          normal,
          toLight.mul(inverseSqrt(distanceSq.add(1e-4))),
        )
          .mul(0.5)
          .add(0.5);
        total.addAssign(
          colorsNode.element(i).rgb.mul(fade.mul(fade).mul(facing)),
        );
      },
    );
    return total;
  },
);

/** Has a Lambert material pick up the bulbs' light on top of its own lighting. */
export function litByBulbs<T extends MeshLambertNodeMaterial>(material: T): T {
  // NodeMaterial reads emissiveNode for every lit material; the Lambert typings just omit it.
  (material as T & { emissiveNode: Node | null }).emissiveNode =
    diffuseColor.rgb.mul(bulbGlow(positionWorld, normalWorld));
  return material;
}
