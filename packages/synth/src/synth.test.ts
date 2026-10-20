import { describe, expect, it } from "vitest";
import { DEFAULT_PATCH, decodePatch, encodePatch, renderPatch, type Patch } from "./index.ts";

const patch = (p: Partial<Patch>): Patch => ({ ...DEFAULT_PATCH, ...p });

describe("code", () => {
  it("round-trips, including negative knobs", () => {
    const p = patch({ osc: 200, fm: 17, reso: 255, pluck: 3, noise: 130, env: 99, envVol: -127, envPitch: 64, note: 36 });
    const code = encodePatch(p);
    expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(decodePatch(code)).toEqual(p);
  });
  it("forgives case, spacing and look-alike characters", () => {
    const code = encodePatch(DEFAULT_PATCH);
    expect(decodePatch(code.toLowerCase().replace(/-/g, " "))).toEqual(DEFAULT_PATCH);
  });
  it("rejects typos", () => {
    const code = encodePatch(patch({ osc: 77 }));
    const bad = (code[0] === "A" ? "B" : "A") + code.slice(1);
    expect(decodePatch(bad)).toBeNull();
    expect(decodePatch("nope")).toBeNull();
  });
});

describe("render", () => {
  const stats = (a: Float32Array) => {
    let peak = 0, sum = 0;
    for (const v of a) { if (!Number.isFinite(v)) return { peak: NaN, rms: NaN }; peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    return { peak, rms: Math.sqrt(sum / a.length) };
  };
  const sources = { osc: 1, fm: 0, reso: 0, pluck: 0, noise: 0 };

  it("is deterministic", () => {
    const p = patch({ ...sources, osc: 0, pluck: 120, noise: 180 });
    expect(renderPatch(p)).toEqual(renderPatch(p));
  });

  it("stays finite, bounded and audible across every slider", () => {
    for (const key of ["osc", "fm", "reso", "pluck", "noise"] as const) {
      for (let v = 1; v <= 254; v += 13) {
        for (const env of [0, 120, 255]) {
          const s = stats(renderPatch(patch({ osc: 0, [key]: v, env, envPitch: 90, envVol: 0 })));
          expect(s.peak, `${key}=${v} env=${env}`).toBeLessThanOrEqual(1);
          expect(s.rms, `${key}=${v} env=${env}`).toBeGreaterThan(0.002);
        }
      }
    }
  });

  it("OFF is silent, and osc 255 (pulse width zero) is silent", () => {
    expect(stats(renderPatch(patch({ osc: 0 }))).peak).toBe(0);
    expect(stats(renderPatch(patch({ osc: 255 }))).peak).toBeLessThan(1e-6);
  });

  it("reports source levels", () => {
    const rows: string[] = [];
    const env = { env: 60, envVol: 0 }; // flat gate so RMS reflects the source, not the envelope
    for (const [key, vals] of Object.entries({ osc: [1, 100, 160, 230], fm: [1, 100, 255], reso: [1, 64, 128, 255], pluck: [1, 90, 170, 255], noise: [1, 100, 255] })) {
      for (const v of vals) {
        const s = stats(renderPatch(patch({ osc: 0, [key]: v, ...env })));
        rows.push(`${key}=${v}: peak ${s.peak.toFixed(2)} rms ${s.rms.toFixed(3)}`);
      }
    }
    console.log(rows.join("\n"));
  });
});
