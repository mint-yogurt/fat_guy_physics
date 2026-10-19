import { Vector3, type BufferAttribute, type BufferGeometry } from "three/webgpu";

/**
 * Turns an inside-out authored mesh right side out.
 *
 * Some of the exported meshes -- the player's parts, tree_large's foliage --
 * have their triangles wound the wrong way round, with the normals to match:
 * the artist's mesh had its faces flipped before it was exported. A mesh like
 * that draws inside out. Backface culling throws away the triangles facing
 * the camera and keeps the ones on the far side, so the model looks hollow:
 * you see the inside of its back through where its front should be.
 *
 * Fixing it in the files means re-exporting, and the next export is as likely
 * to come back flipped, so it is fixed on load instead. A mesh that is
 * already the right way round is left exactly as it is.
 */

type Triangles = (visit: (a: number, b: number, c: number) => void) => void;

/** Walks a geometry's triangles as vertex indices, indexed or not. */
function triangles(geometry: BufferGeometry): Triangles {
  const index = geometry.index;
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  const count = index === null ? (position?.count ?? 0) : index.count;
  return (visit) => {
    for (let t = 0; t + 2 < count; t += 3) {
      if (index === null) visit(t, t + 1, t + 2);
      else visit(index.getX(t), index.getX(t + 1), index.getX(t + 2));
    }
  };
}

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
const u = new Vector3();
const v = new Vector3();

/**
 * The volume a mesh's triangles enclose, signed by their winding: positive
 * if they face outward, negative if inward.
 *
 * Each triangle contributes the tetrahedron it makes with the origin; for a
 * closed mesh those cancel out to the enclosed volume wherever the origin
 * happens to sit. Also returns the surface area, which is what tells whether
 * that volume means anything -- the two want the same pass over the data.
 */
function measure(geometry: BufferGeometry): { volume: number; area: number } {
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  if (position === undefined) return { volume: 0, area: 0 };

  let volume = 0;
  let area = 0;
  triangles(geometry)((i, j, k) => {
    a.fromBufferAttribute(position, i);
    b.fromBufferAttribute(position, j);
    c.fromBufferAttribute(position, k);
    volume += a.dot(u.copy(b).cross(c)) / 6;
    area += u.copy(b).sub(a).cross(v.copy(c).sub(a)).length() / 2;
  });
  return { volume, area };
}

/**
 * How solid a mesh has to look before its winding is read as a statement
 * about which way is out.
 *
 * Volume grows as the cube of a mesh's size and area as the square, so
 * volume/area^1.5 measures solidity whatever scale the mesh was modelled at.
 * Across the authored meshes it runs from 0.013 (a thin conifer frond) to
 * 0.29 (the trampoline's feet), and is exactly zero for an open sheet like
 * the trampoline's mat. The threshold sits below the thinnest solid mesh and
 * above a flat one, so an open mesh -- a billboard, a mat, a trunk sliced
 * open by a cut -- is never flipped on the strength of an enclosed volume
 * that does not mean anything.
 */
const SOLIDITY = 0.005;

/** True if the mesh's triangles enclose a volume the wrong way round. */
export function facesInward(geometry: BufferGeometry): boolean {
  const { volume, area } = measure(geometry);
  if (area <= 0) return false;
  return volume < -SOLIDITY * Math.pow(area, 1.5);
}

/**
 * Reverses a mesh's winding and its normals, in place.
 *
 * Both have to go: the winding is what culling and `gl_FrontFacing` read,
 * and the normals are what lighting reads.
 */
export function reverseWinding(geometry: BufferGeometry): void {
  const index = geometry.index;
  if (index === null) {
    // Swapping the second and third corner of every triangle flips it,
    // and every attribute has to follow the positions.
    for (const attribute of Object.values(geometry.attributes)) {
      const data = attribute as BufferAttribute;
      for (let t = 0; t + 2 < data.count; t += 3) {
        for (let component = 0; component < data.itemSize; component++) {
          const swap = data.getComponent(t + 1, component);
          data.setComponent(t + 1, component, data.getComponent(t + 2, component));
          data.setComponent(t + 2, component, swap);
        }
      }
      data.needsUpdate = true;
    }
  } else {
    for (let t = 0; t + 2 < index.count; t += 3) {
      const swap = index.getX(t + 1);
      index.setX(t + 1, index.getX(t + 2));
      index.setX(t + 2, swap);
    }
    index.needsUpdate = true;
  }

  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  if (normal === undefined) return;
  for (let i = 0; i < normal.count; i++) {
    normal.setXYZ(i, -normal.getX(i), -normal.getY(i), -normal.getZ(i));
  }
  normal.needsUpdate = true;
}

/**
 * Flips a mesh if it was authored inside out. Call it before anything copies
 * the geometry's data, since it rewrites the attributes in place.
 */
export function faceOutward(geometry: BufferGeometry): BufferGeometry {
  if (facesInward(geometry)) reverseWinding(geometry);
  return geometry;
}
