/**
 * Rotation helpers on plain numbers, for the sim (no three.js here).
 *
 * A rotation is carried two ways: a unit quaternion (what Jolt and three.js
 * take) and a 3x3 matrix stored as a Float64Array(9), *column-major*: entries
 * 0-2 are where the thing's own X axis points in the world, 3-5 its Y, 6-8 its
 * Z. The matrix form is what the box tests and the placement planner want (the
 * axes are right there); the quaternion is what gets stored and handed on.
 */

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export function createQuat(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function createMat3(): Float64Array {
  const m = new Float64Array(9);
  m[0] = 1;
  m[4] = 1;
  m[8] = 1;
  return m;
}

/** The quaternion for a turn of `yaw` radians about +Y (three.js `rotation.y`). */
export function quatFromYaw(yaw: number, out: Quat): Quat {
  out.x = 0;
  out.y = Math.sin(yaw / 2);
  out.z = 0;
  out.w = Math.cos(yaw / 2);
  return out;
}

/** Writes the rotation of unit quaternion (x, y, z, w) into `m`. */
export function matFromQuat(x: number, y: number, z: number, w: number, m: Float64Array): Float64Array {
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  m[0] = 1 - 2 * (yy + zz);
  m[1] = 2 * (xy + wz);
  m[2] = 2 * (xz - wy);
  m[3] = 2 * (xy - wz);
  m[4] = 1 - 2 * (xx + zz);
  m[5] = 2 * (yz + wx);
  m[6] = 2 * (xz + wy);
  m[7] = 2 * (yz - wx);
  m[8] = 1 - 2 * (xx + yy);
  return m;
}

/** The unit quaternion of rotation matrix `m`. */
export function quatFromMat(m: Float64Array, out: Quat): Quat {
  const m00 = m[0] ?? 1;
  const m10 = m[1] ?? 0;
  const m20 = m[2] ?? 0;
  const m01 = m[3] ?? 0;
  const m11 = m[4] ?? 1;
  const m21 = m[5] ?? 0;
  const m02 = m[6] ?? 0;
  const m12 = m[7] ?? 0;
  const m22 = m[8] ?? 1;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out.w = s / 4;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = s / 4;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = s / 4;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = s / 4;
  }
  const length = Math.hypot(out.x, out.y, out.z, out.w) || 1;
  out.x /= length;
  out.y /= length;
  out.z /= length;
  out.w /= length;
  return out;
}

/**
 * Turns every column of `m` about the unit axis (kx, ky, kz) by `angle`
 * (right-handed), in place: the whole rotation, turned.
 */
export function turnMat(m: Float64Array, kx: number, ky: number, kz: number, angle: number): void {
  if (angle === 0) return;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let column = 0; column < 3; column++) {
    const vx = m[column * 3] ?? 0;
    const vy = m[column * 3 + 1] ?? 0;
    const vz = m[column * 3 + 2] ?? 0;
    const dot = kx * vx + ky * vy + kz * vz;
    // Rodrigues: v c + (k x v) s + k (k . v)(1 - c)
    m[column * 3] = vx * c + (ky * vz - kz * vy) * s + kx * dot * (1 - c);
    m[column * 3 + 1] = vy * c + (kz * vx - kx * vz) * s + ky * dot * (1 - c);
    m[column * 3 + 2] = vz * c + (kx * vy - ky * vx) * s + kz * dot * (1 - c);
  }
}
