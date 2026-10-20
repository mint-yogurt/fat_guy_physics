/**
 * A patch is nine small integers, and its shareable "code" is those nine
 * bytes plus a checksum byte, written as 16 Crockford base32 characters:
 *
 *     7K2M-9QXA-0F3D-V8TH
 *
 * 10 bytes = 80 bits = exactly 16 characters of 5 bits, so there is no padding
 * and nothing wasted. Crockford's alphabet drops I L O U and decodes them as
 * 1 1 0 (and ignores case and dashes), so a code survives being read aloud,
 * retyped or pasted out of a chat.
 */

export interface Patch {
  /** 0 off, 1 sine .. triangle .. sharktooth .. saw .. square .. narrow pulse, 255 silent. */
  osc: number;
  /** 0 off, 1..255 soft FM through bell and metal to clangorous. */
  fm: number;
  /** 0 off, 1..255 woodblock, thud, machinery, clang, glass. */
  reso: number;
  /** 0 off, 1..255 pluck, elastic boing, buzzing wire, rain on tin. */
  pluck: number;
  /** 0 off, 1 pink .. white .. progressively bit/rate-crushed. */
  noise: number;
  /** 0 instant attack + short decay .. 127 smooth sine .. 255 slow attack + quick decay. */
  env: number;
  /** Envelope -> volume, -127..127 (negative inverts, 0 = flat gate). */
  envVol: number;
  /** Envelope -> pitch, -127..127 (negative inverts; tapered, so small values are subtle). */
  envPitch: number;
  /** MIDI note, 0..127. Callers may override it per play. */
  note: number;
}

export const PATCH_FIELDS = [
  "osc", "fm", "reso", "pluck", "noise", "env", "envVol", "envPitch", "note",
] as const satisfies readonly (keyof Patch)[];

export const DEFAULT_PATCH: Readonly<Patch> = {
  osc: 1, fm: 0, reso: 0, pluck: 0, noise: 0,
  env: 40, envVol: 127, envPitch: 0, note: 60,
};

const RANGES: Record<keyof Patch, [number, number]> = {
  osc: [0, 255], fm: [0, 255], reso: [0, 255], pluck: [0, 255], noise: [0, 255],
  env: [0, 255], envVol: [-127, 127], envPitch: [-127, 127], note: [0, 127],
};

export function clampPatch(p: Partial<Patch>): Patch {
  const out = { ...DEFAULT_PATCH };
  for (const k of PATCH_FIELDS) {
    const v = p[k];
    if (v === undefined || !Number.isFinite(v)) continue;
    const [lo, hi] = RANGES[k];
    out[k] = Math.min(hi, Math.max(lo, Math.round(v)));
  }
  return out;
}

// ---------------------------------------------------------------- code

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BIPOLAR_OFFSET = 127;

function crc8(bytes: ArrayLike<number>): number {
  let crc = 0xa5; // non-zero seed so an all-zero payload doesn't checksum to zero
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i]!;
    for (let b = 0; b < 8; b++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

function toBytes(p: Patch): number[] {
  return [
    p.osc, p.fm, p.reso, p.pluck, p.noise, p.env,
    p.envVol + BIPOLAR_OFFSET, p.envPitch + BIPOLAR_OFFSET, p.note,
  ];
}

export function encodePatch(patch: Partial<Patch>): string {
  const bytes = toBytes(clampPatch(patch));
  bytes.push(crc8(bytes));
  let bits = 0, acc = 0, out = "";
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}`;
}

/** Returns null for anything that isn't a well-formed code with a matching checksum. */
export function decodePatch(code: string): Patch | null {
  const text = code.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (text.length !== 16) return null;
  const bytes: number[] = [];
  let bits = 0, acc = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 255);
      acc &= (1 << bits) - 1;
    }
  }
  if (bytes.length !== 10 || crc8(bytes.slice(0, 9)) !== bytes[9]) return null;
  const [osc, fm, reso, pluck, noise, env, vol, pitch, note] = bytes as [
    number, number, number, number, number, number, number, number, number,
  ];
  const p = {
    osc, fm, reso, pluck, noise, env,
    envVol: vol - BIPOLAR_OFFSET, envPitch: pitch - BIPOLAR_OFFSET, note,
  };
  // A well-formed checksum with out-of-range fields means a different
  // version of this format, not a typo; refuse rather than silently clamp.
  for (const k of PATCH_FIELDS) {
    const [lo, hi] = RANGES[k];
    if (p[k] < lo || p[k] > hi) return null;
  }
  return p;
}
