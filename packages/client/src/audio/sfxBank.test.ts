import { decodePatch, renderPatch } from "@fgp/synth";
import { describe, expect, it } from "vitest";

import doc from "../../../../sfx.md?raw";

import { SFX } from "./sfxBank.ts";

const CODE = /\b[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\b/g;

describe("sfx bank", () => {
  it("holds only valid codes that render something audible and finite", () => {
    for (const [name, code] of Object.entries(SFX)) {
      const patch = decodePatch(code);
      expect(patch, name).not.toBeNull();
      if (patch === null) continue;
      const samples = renderPatch(patch);
      let peak = 0;
      for (const v of samples) {
        expect(Number.isFinite(v), name).toBe(true);
        peak = Math.max(peak, Math.abs(v));
      }
      expect(peak, `${name} is silent`).toBeGreaterThan(0.01);
    }
    // Rendering every patch takes seconds, and grows with each sound added.
  }, 30_000);

  it("matches sfx.md, the document people edit", () => {
    const documented = new Set(doc.match(CODE) ?? []);
    const bank = new Set<string>(Object.values(SFX));
    expect([...bank].filter((code) => !documented.has(code))).toEqual([]);
    expect([...documented].filter((code) => !bank.has(code))).toEqual([]);
  });
});
