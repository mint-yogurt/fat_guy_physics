import {
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  MeshStandardNodeMaterial,
  Quaternion,
  Vector3,
  type Node,
  type Scene,
} from "three/webgpu";
import {
  color,
  float,
  mix,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  pow,
  saturate,
  smoothstep,
  time,
  uv,
  vec2,
  vec3,
} from "three/tsl";

/**
 * Slime. One look for everything made of it: the goo item, the ball of goo in
 * the hand, and the stain it leaves where it splats. See-through and wet: a
 * lime green that swirls slowly inside itself, clearer in the middle of a
 * lump and more solid at its rim, with the sun glinting off it hard.
 *
 * The green is also the colour of the fizz a burst can of mountain lightning
 * sprays, which is why it is exported.
 */

/** The slime's body colour, and the spread of greens its spray is drawn in. */
export const GOO_COLOR = 0x62e03c;
export const GOO_SPRAY_COLORS: readonly number[] = [0x62e03c, 0x62e03c, 0x8cf05a, 0x3fc42e, 0xc2ff7a];
const GOO_DEEP = 0x2a9a2a;

/** The swirling colour of the slime, from a position that stays put on the thing. */
function gooColour(at: Node<"vec3">, speed: number) {
  const drift = vec3(time.mul(speed * 0.4), time.mul(speed), time.mul(speed * 0.7));
  const swirl = mx_noise_float(at.mul(9).add(drift)).mul(0.5).add(0.5);
  return mix(color(GOO_DEEP), color(GOO_COLOR), swirl);
}

/** Wet and bright: glossy, with a little glow of its own so it does not go dull at dusk. */
function wet(material: MeshStandardNodeMaterial): void {
  material.roughness = 0.05;
  material.metalness = 0;
  material.transparent = true;
  material.depthWrite = false;
  material.side = DoubleSide;
}

/** The goo item and the ball of goo. */
export function createGooMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  wet(material);
  const body = gooColour(positionLocal, 0.3);
  const facing = saturate(normalView.dot(positionViewDirection).abs());
  // Edge-on surfaces are the thick of the lump: more solid there than head on.
  const rim = pow(float(1).sub(facing), 2.5);
  material.colorNode = body;
  material.emissiveNode = body.mul(0.22);
  material.opacityNode = float(0.66).add(rim.mul(0.34));
  return material;
}

/** The splat on the ground or a wall: a blob with a wobbling edge, drawn on a plane with uvs. */
export function createStainMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial();
  wet(material);
  material.polygonOffset = true;
  material.polygonOffsetFactor = -2;
  material.polygonOffsetUnits = -2;

  const p = uv().sub(vec2(0.5, 0.5));
  const edgeNoise = mx_noise_float(vec3(p.x.mul(7), p.y.mul(7), 3.1));
  // 1 at the middle, 0 past the rim; the rim wanders so no two stains read as one disc.
  const radius = p.length().mul(2).add(edgeNoise.mul(0.2));
  const blob = float(1).sub(smoothstep(0.62, 0.8, radius));
  // Thicker (more solid, darker) towards the middle; the thin edge is clearer.
  const thick = float(1).sub(smoothstep(0.0, 0.8, radius));
  const swirl = gooColour(vec3(p.x, p.y, 0.5), 0.12);
  material.colorNode = mix(swirl, color(GOO_DEEP), thick.mul(0.35));
  material.emissiveNode = swirl.mul(0.18);
  material.opacityNode = blob.mul(float(0.6).add(thick.mul(0.3)));
  return material;
}

/** Seconds a stain lasts, and the last of that over which it shrinks away. */
const STAIN_LIFE = 90;
const STAIN_FADE = 6;
const MAX_STAINS = 28;
/** Held off the surface it is on, so the two do not fight over the pixels. */
const STAIN_LIFT = 0.018;

interface Stain {
  mesh: Mesh;
  age: number;
  size: number;
}

/** Goo stains left on the world: flat blobs lying on whatever the goo hit, oldest replaced first. */
export class GooStains {
  private readonly stains: Stain[] = [];
  private readonly material = createStainMaterial();
  private readonly geometry: BufferGeometry;
  private next = 0;

  constructor(private readonly scene: Scene) {
    // A unit square facing +Z.
    this.geometry = new BufferGeometry();
    this.geometry.setAttribute(
      "position",
      new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3),
    );
    this.geometry.setAttribute("normal", new Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    this.geometry.setAttribute("uv", new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);
  }

  get count(): number {
    return this.stains.length;
  }

  /** A stain of `radius` metres lying on the surface at (x, y, z) that faces (nx, ny, nz). */
  add(x: number, y: number, z: number, nx: number, ny: number, nz: number, radius: number): void {
    if (radius <= 0) return;
    let stain = this.stains[this.next];
    if (stain === undefined) {
      const mesh = new Mesh(this.geometry, this.material);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.scene.add(mesh);
      stain = { mesh, age: 0, size: 0 };
      this.stains[this.next] = stain;
    }
    this.next = (this.next + 1) % MAX_STAINS;

    const normal = new Vector3(nx, ny, nz).normalize();
    const { mesh } = stain;
    mesh.quaternion.setFromUnitVectors(Z, normal);
    // Turned about its own normal, so a row of them is not a row of twins.
    mesh.quaternion.multiply(spin.setFromAxisAngle(Z, Math.random() * Math.PI * 2));
    mesh.position.set(x + normal.x * STAIN_LIFT, y + normal.y * STAIN_LIFT, z + normal.z * STAIN_LIFT);
    stain.size = radius * 2;
    stain.age = 0;
    mesh.scale.setScalar(stain.size);
    mesh.visible = true;
  }

  update(dt: number): void {
    for (const stain of this.stains) {
      if (!stain.mesh.visible) continue;
      stain.age += dt;
      const left = STAIN_LIFE - stain.age;
      if (left <= 0) {
        stain.mesh.visible = false;
        continue;
      }
      stain.mesh.scale.setScalar(stain.size * Math.min(1, left / STAIN_FADE));
    }
  }

  clear(): void {
    for (const stain of this.stains) this.scene.remove(stain.mesh);
    this.stains.length = 0;
    this.next = 0;
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}

const Z = new Vector3(0, 0, 1);
const spin = new Quaternion();
