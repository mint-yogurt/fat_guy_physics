import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix3,
  Mesh,
  Vector3,
  type BufferAttribute,
  type Material,
  type Object3D,
  type Scene,
} from "three/webgpu";

/**
 * Blows a model apart into its triangles. Each triangle becomes a piece of its
 * own, thrown out from the middle of the model, tumbling, falling on plain
 * gravity, shrinking away over its last moments and then gone. A gingerbread
 * house that has been hit enough is what uses it.
 */

const GRAVITY = 9.8;
/** Out from the middle, m/s, and the lift every piece gets on top of that. */
const OUT_SPEED_MIN = 0.8;
const OUT_SPEED_MAX = 2.5;
const LIFT_MIN = 0.6;
const LIFT_MAX = 1.8;
/** Tumble, radians per second at most either way about each axis. */
const SPIN = 6;
/** How long a piece lasts, seconds, and the last of that over which it shrinks to nothing. */
const LIFE_MIN = 0.5;
const LIFE_MAX = 0.9;
const SHRINK = 0.4;

interface Piece {
  readonly mesh: Mesh;
  vx: number;
  vy: number;
  vz: number;
  readonly spinX: number;
  readonly spinY: number;
  readonly spinZ: number;
  age: number;
  readonly life: number;
}

export class Shatter {
  private readonly pieces: Piece[] = [];

  constructor(private readonly scene: Scene) {}

  get count(): number {
    return this.pieces.length;
  }

  /**
   * Breaks `model` (placed in the world, its world matrices up to date) into
   * triangle pieces, thrown out from (cx, cy, cz). The model itself is left
   * alone; hide or remove it.
   */
  explode(model: Object3D, cx: number, cy: number, cz: number): void {
    const a = new Vector3();
    const b = new Vector3();
    const c = new Vector3();
    const centre = new Vector3();
    const normalMatrix = new Matrix3();

    model.traverse((node) => {
      if (!(node instanceof Mesh) || !node.visible) return;
      const geometry = node.geometry;
      const position = geometry.getAttribute("position") as BufferAttribute;
      const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
      const uv = geometry.getAttribute("uv") as BufferAttribute | undefined;
      const index = geometry.index;
      const count = index === null ? position.count : index.count;
      const world = node.matrixWorld;
      normalMatrix.getNormalMatrix(world);
      const material = node.material as Material | Material[];

      for (let t = 0; t + 2 < count; t += 3) {
        const i0 = index === null ? t : index.getX(t);
        const i1 = index === null ? t + 1 : index.getX(t + 1);
        const i2 = index === null ? t + 2 : index.getX(t + 2);
        a.fromBufferAttribute(position, i0).applyMatrix4(world);
        b.fromBufferAttribute(position, i1).applyMatrix4(world);
        c.fromBufferAttribute(position, i2).applyMatrix4(world);
        centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);

        const positions = [
          a.x - centre.x, a.y - centre.y, a.z - centre.z,
          b.x - centre.x, b.y - centre.y, b.z - centre.z,
          c.x - centre.x, c.y - centre.y, c.z - centre.z,
        ];
        const piece = new BufferGeometry();
        piece.setAttribute("position", new Float32BufferAttribute(positions, 3));
        if (normal !== undefined) {
          const normals: number[] = [];
          for (const i of [i0, i1, i2]) {
            const n = new Vector3().fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
            normals.push(n.x, n.y, n.z);
          }
          piece.setAttribute("normal", new Float32BufferAttribute(normals, 3));
        }
        if (uv !== undefined) {
          const uvs: number[] = [];
          for (const i of [i0, i1, i2]) uvs.push(uv.getX(i), uv.getY(i));
          piece.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
        }

        const mesh = new Mesh(piece, Array.isArray(material) ? (material[0] as Material) : material);
        mesh.position.copy(centre);
        mesh.frustumCulled = false;
        this.scene.add(mesh);

        // Out from the middle of the model, more or less; straight up if it is right on it.
        let ox = centre.x - cx;
        let oz = centre.z - cz;
        const flat = Math.hypot(ox, oz);
        if (flat < 1e-3) {
          const angle = Math.random() * Math.PI * 2;
          ox = Math.cos(angle);
          oz = Math.sin(angle);
        } else {
          ox /= flat;
          oz /= flat;
        }
        const out = OUT_SPEED_MIN + Math.random() * (OUT_SPEED_MAX - OUT_SPEED_MIN);
        this.pieces.push({
          mesh,
          vx: ox * out + (Math.random() - 0.5) * 0.8,
          vy: LIFT_MIN + Math.random() * (LIFT_MAX - LIFT_MIN) + Math.max(0, centre.y - cy) * 0.4,
          vz: oz * out + (Math.random() - 0.5) * 0.8,
          spinX: (Math.random() - 0.5) * SPIN,
          spinY: (Math.random() - 0.5) * SPIN,
          spinZ: (Math.random() - 0.5) * SPIN,
          age: 0,
          life: LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN),
        });
      }
    });
  }

  update(dt: number): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) {
      const piece = this.pieces[i] as Piece;
      piece.age += dt;
      if (piece.age >= piece.life) {
        this.remove(i);
        continue;
      }
      piece.vy -= GRAVITY * dt;
      const { mesh } = piece;
      mesh.position.x += piece.vx * dt;
      mesh.position.y += piece.vy * dt;
      mesh.position.z += piece.vz * dt;
      mesh.rotation.x += piece.spinX * dt;
      mesh.rotation.y += piece.spinY * dt;
      mesh.rotation.z += piece.spinZ * dt;
      mesh.scale.setScalar(Math.min(1, (piece.life - piece.age) / SHRINK));
    }
  }

  clear(): void {
    for (let i = this.pieces.length - 1; i >= 0; i--) this.remove(i);
  }

  private remove(index: number): void {
    const piece = this.pieces[index] as Piece;
    this.scene.remove(piece.mesh);
    piece.mesh.geometry.dispose();
    this.pieces.splice(index, 1);
  }
}
