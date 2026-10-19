import { VOXEL_SIZE } from "../sim/constants.ts";
import { FLOATS_PER_VERTEX, faceTint } from "./vertexLayout.ts";
import { MATERIAL_COLORS, Material, isSolid } from "./voxel.ts";
import type { VoxelGrid } from "./voxelGrid.ts";

/**
 * Greedy voxel mesher, ported from src/voxel/ChunkMesher.cpp.
 *
 * Two changes from the C++, both deliberate:
 *
 * 1. **Generalised to arbitrary grid dimensions.** The C++ hardcodes
 *    kChunkSize everywhere, including as the mask's row stride -- which is
 *    only correct because the grid is a cube. Here the stride is `dimU`.
 *    This is what lets trees and felled logs use the real greedy mesher
 *    instead of the per-voxel box mesher they use today, which is an ~8-10MB
 *    per-tree geometry bomb rebuilt on every chop tick.
 *
 * 2. **Scratch buffers are owned and reused.** The C++ allocates a
 *    std::vector mask per axis and grows a std::vector<Vertex> per chunk.
 *    Doing the JS equivalent -- an object per mask cell, an array of vertex
 *    objects -- is ~100k allocations per chunk and is the single most common
 *    reason browser voxel ports end up 10-30x slower than they need to be.
 *    One Mesher instance per worker, allocated once.
 *
 * Unchanged and load-bearing: neighbouring grids are never consulted, so
 * boundary faces are always emitted. That trades some hidden inter-chunk
 * overdraw for generation staying a pure function of (seed, coord) with no
 * cross-chunk dependency -- which is also what makes terrain replication
 * nearly free over the network later.
 */

export interface MeshData {
  /** Interleaved, non-indexed, FLOATS_PER_VERTEX per vertex. */
  readonly vertices: Float32Array;
  readonly vertexCount: number;
}

/** Axis strides into `grid.cells` for x, y, z. */
function axisStride(grid: VoxelGrid, axis: number): number {
  if (axis === 0) return 1;
  if (axis === 1) return grid.dimX;
  return grid.dimX * grid.dimY;
}

function axisDim(grid: VoxelGrid, axis: number): number {
  if (axis === 0) return grid.dimX;
  if (axis === 1) return grid.dimY;
  return grid.dimZ;
}

export class Mesher {
  /**
   * Parallel arrays rather than an array of {material, backFace} objects.
   * `maskMaterial` of Air means "no face here"; the C++ MaskCell default.
   */
  private maskMaterial = new Uint8Array(0);
  private maskBackFace = new Uint8Array(0);
  private vertices = new Float32Array(0);
  private vertexCount = 0;

  /** Reused per-quad corner scratch, so emitQuad allocates nothing. */
  private readonly origin = new Int32Array(3);
  private readonly du = new Int32Array(3);
  private readonly dv = new Int32Array(3);
  private readonly normal = new Float32Array(3);

  private ensureMask(size: number): void {
    if (this.maskMaterial.length < size) {
      this.maskMaterial = new Uint8Array(size);
      this.maskBackFace = new Uint8Array(size);
    }
  }

  private ensureVertexCapacity(floatsNeeded: number): void {
    if (this.vertices.length >= floatsNeeded) return;
    // Grow geometrically and keep what's already written -- a mid-mesh
    // reallocation must not lose the quads emitted so far.
    let capacity = Math.max(this.vertices.length * 2, 4096);
    while (capacity < floatsNeeded) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.vertices.subarray(0, this.vertexCount * FLOATS_PER_VERTEX));
    this.vertices = grown;
  }

  /**
   * Meshes `grid` into an interleaved vertex buffer.
   *
   * Positions are in metres relative to the grid's `originLocal` cell, so a
   * chunk (origin 0,0,0) comes out in chunk-local metres exactly as the C++
   * produces, and a tree comes out relative to its trunk root.
   *
   * The returned Float32Array is a **view onto reusable internal storage**.
   * Copy it (or transfer it) before meshing anything else with this Mesher.
   */
  mesh(grid: VoxelGrid): MeshData {
    this.vertexCount = 0;
    for (let d = 0; d < 3; ++d) this.meshAxis(grid, d);
    return {
      vertices: this.vertices.subarray(0, this.vertexCount * FLOATS_PER_VERTEX),
      vertexCount: this.vertexCount,
    };
  }

  private meshAxis(grid: VoxelGrid, d: number): void {
    const u = (d + 1) % 3;
    const v = (d + 2) % 3;

    const dimD = axisDim(grid, d);
    const dimU = axisDim(grid, u);
    const dimV = axisDim(grid, v);

    const strideD = axisStride(grid, d);
    const strideU = axisStride(grid, u);
    const strideV = axisStride(grid, v);

    const maskSize = dimU * dimV;
    this.ensureMask(maskSize);
    const maskMaterial = this.maskMaterial;
    const maskBackFace = this.maskBackFace;
    const cells = grid.cells;

    // Sweeps planes -1..dimD-1, comparing the cell at cd against cd+1. The
    // -1 start is what emits the grid's lower boundary plane, and the final
    // iteration emits the upper one, since out-of-range reads as Air.
    for (let cd = -1; cd < dimD; ++cd) {
      const inLowRange = cd >= 0;
      const inHighRange = cd + 1 < dimD;
      const baseLow = cd * strideD;
      const baseHigh = (cd + 1) * strideD;

      let n = 0;
      for (let cv = 0; cv < dimV; ++cv) {
        const offsetV = cv * strideV;
        for (let cu = 0; cu < dimU; ++cu, ++n) {
          const offset = offsetV + cu * strideU;
          const a = inLowRange ? (cells[baseLow + offset] as Material) : Material.Air;
          const b = inHighRange ? (cells[baseHigh + offset] as Material) : Material.Air;
          const aSolid = isSolid(a);
          const bSolid = isSolid(b);

          if (aSolid === bSolid) {
            maskMaterial[n] = Material.Air;
            maskBackFace[n] = 0;
          } else if (aSolid) {
            maskMaterial[n] = a;
            maskBackFace[n] = 0;
          } else {
            maskMaterial[n] = b;
            maskBackFace[n] = 1;
          }
        }
      }

      // The face plane sits between cd and cd+1, i.e. at cd+1.
      const planeD = cd + 1;

      n = 0;
      for (let j = 0; j < dimV; ++j) {
        for (let i = 0; i < dimU; ) {
          const material = maskMaterial[n] as Material;
          if (material === Material.Air) {
            ++i;
            ++n;
            continue;
          }
          const backFace = maskBackFace[n] as number;

          // Grow width along u while cells match.
          let w = 1;
          while (
            i + w < dimU &&
            maskMaterial[n + w] === material &&
            maskBackFace[n + w] === backFace
          ) {
            ++w;
          }

          // Grow height along v while the whole w-wide row matches. Row
          // stride is dimU -- the C++ uses kChunkSize here, which is the
          // same number only because its grid is a cube.
          let h = 1;
          let done = false;
          for (; j + h < dimV; ++h) {
            for (let k = 0; k < w; ++k) {
              const m = n + k + h * dimU;
              if (maskMaterial[m] !== material || maskBackFace[m] !== backFace) {
                done = true;
                break;
              }
            }
            if (done) break;
          }

          this.origin[d] = planeD;
          this.origin[u] = i;
          this.origin[v] = j;
          this.du[0] = this.du[1] = this.du[2] = 0;
          this.du[u] = w;
          this.dv[0] = this.dv[1] = this.dv[2] = 0;
          this.dv[v] = h;
          this.normal[0] = this.normal[1] = this.normal[2] = 0;
          this.normal[d] = backFace ? -1 : 1;

          this.emitQuad(grid, backFace !== 0, material, w, h, faceTint(d, backFace !== 0));

          // Zero the consumed region so it isn't emitted again.
          for (let l = 0; l < h; ++l) {
            const rowBase = n + l * dimU;
            for (let k = 0; k < w; ++k) {
              maskMaterial[rowBase + k] = Material.Air;
              maskBackFace[rowBase + k] = 0;
            }
          }

          i += w;
          n += w;
        }
      }
    }
  }

  private emitQuad(
    grid: VoxelGrid,
    backFace: boolean,
    material: Material,
    w: number,
    h: number,
    tint: number,
  ): void {
    this.ensureVertexCapacity((this.vertexCount + 6) * FLOATS_PER_VERTEX);

    const out = this.vertices;
    let p = this.vertexCount * FLOATS_PER_VERTEX;

    const ci = material * 3;
    const r = (MATERIAL_COLORS[ci] as number) * tint;
    const g = (MATERIAL_COLORS[ci + 1] as number) * tint;
    const b = (MATERIAL_COLORS[ci + 2] as number) * tint;

    const nx = this.normal[0] as number;
    const ny = this.normal[1] as number;
    const nz = this.normal[2] as number;

    // Positions are relative to the grid's local origin cell.
    const ox = (this.origin[0] as number) - grid.originX;
    const oy = (this.origin[1] as number) - grid.originY;
    const oz = (this.origin[2] as number) - grid.originZ;
    const dux = this.du[0] as number;
    const duy = this.du[1] as number;
    const duz = this.du[2] as number;
    const dvx = this.dv[0] as number;
    const dvy = this.dv[1] as number;
    const dvz = this.dv[2] as number;

    const c0x = ox * VOXEL_SIZE;
    const c0y = oy * VOXEL_SIZE;
    const c0z = oz * VOXEL_SIZE;
    const c1x = (ox + dux) * VOXEL_SIZE;
    const c1y = (oy + duy) * VOXEL_SIZE;
    const c1z = (oz + duz) * VOXEL_SIZE;
    const c2x = (ox + dux + dvx) * VOXEL_SIZE;
    const c2y = (oy + duy + dvy) * VOXEL_SIZE;
    const c2z = (oz + duz + dvz) * VOXEL_SIZE;
    const c3x = (ox + dvx) * VOXEL_SIZE;
    const c3y = (oy + dvy) * VOXEL_SIZE;
    const c3z = (oz + dvz) * VOXEL_SIZE;

    // Corner order per winding. (u, v, d) is a cyclic permutation of
    // (x, y, z), so cross(du, dv) points along +d; front faces keep that
    // winding, back faces reverse it so the visible normal points along -d.
    //
    // UVs span (0,0)-(w,h) so the texture tiles once per voxel under REPEAT
    // rather than stretching across a greedy-merged quad.
    //
    // Written out longhand rather than through a helper closure: a closure
    // capturing the mutable cursor `p` allocates a context object on every
    // quad, which at ~73 chunks/s of streaming is tens of thousands of
    // allocations per second in the steady state -- the exact thing the
    // reusable-scratch design above exists to avoid.
    let xs0: number, ys0: number, zs0: number, us0: number, vs0: number;
    let xs1: number, ys1: number, zs1: number, us1: number, vs1: number;
    let xs2: number, ys2: number, zs2: number, us2: number, vs2: number;

    for (let tri = 0; tri < 2; ++tri) {
      if (tri === 0) {
        xs0 = c0x; ys0 = c0y; zs0 = c0z; us0 = 0; vs0 = 0;
        if (!backFace) {
          xs1 = c1x; ys1 = c1y; zs1 = c1z; us1 = w; vs1 = 0;
          xs2 = c2x; ys2 = c2y; zs2 = c2z; us2 = w; vs2 = h;
        } else {
          xs1 = c2x; ys1 = c2y; zs1 = c2z; us1 = w; vs1 = h;
          xs2 = c1x; ys2 = c1y; zs2 = c1z; us2 = w; vs2 = 0;
        }
      } else {
        xs0 = c0x; ys0 = c0y; zs0 = c0z; us0 = 0; vs0 = 0;
        if (!backFace) {
          xs1 = c2x; ys1 = c2y; zs1 = c2z; us1 = w; vs1 = h;
          xs2 = c3x; ys2 = c3y; zs2 = c3z; us2 = 0; vs2 = h;
        } else {
          xs1 = c3x; ys1 = c3y; zs1 = c3z; us1 = 0; vs1 = h;
          xs2 = c2x; ys2 = c2y; zs2 = c2z; us2 = w; vs2 = h;
        }
      }

      out[p] = xs0; out[p + 1] = ys0; out[p + 2] = zs0;
      out[p + 3] = r; out[p + 4] = g; out[p + 5] = b;
      out[p + 6] = us0; out[p + 7] = vs0;
      out[p + 8] = nx; out[p + 9] = ny; out[p + 10] = nz;
      p += FLOATS_PER_VERTEX;

      out[p] = xs1; out[p + 1] = ys1; out[p + 2] = zs1;
      out[p + 3] = r; out[p + 4] = g; out[p + 5] = b;
      out[p + 6] = us1; out[p + 7] = vs1;
      out[p + 8] = nx; out[p + 9] = ny; out[p + 10] = nz;
      p += FLOATS_PER_VERTEX;

      out[p] = xs2; out[p + 1] = ys2; out[p + 2] = zs2;
      out[p + 3] = r; out[p + 4] = g; out[p + 5] = b;
      out[p + 6] = us2; out[p + 7] = vs2;
      out[p + 8] = nx; out[p + 9] = ny; out[p + 10] = nz;
      p += FLOATS_PER_VERTEX;
    }

    this.vertexCount += 6;
  }
}

/**
 * Convenience for one-off meshing: returns an owned copy rather than a view
 * onto reusable scratch. Workers should hold a long-lived Mesher instead.
 */
export function buildMesh(grid: VoxelGrid): MeshData {
  const data = new Mesher().mesh(grid);
  return { vertices: data.vertices.slice(), vertexCount: data.vertexCount };
}
