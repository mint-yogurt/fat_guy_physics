import {
  DEFAULT_PATCH, OSC_NAMES, PLUCK_NAMES, RESO_NAMES, SynthPlayer,
  clampPatch, decodePatch, encodePatch, envShape, envValue, renderPatch,
  type Patch,
} from "../src/index.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`;
const nearest = (names: string[], v: number) => names[Math.round(((v - 1) / 254) * (names.length - 1))]!;

type SliderKey = "osc" | "fm" | "reso" | "pluck" | "noise" | "env";
const SLIDERS: { key: SliderKey; label: string; describe: (v: number) => string }[] = [
  {
    key: "osc", label: "OSC",
    describe: (v) => {
      if (v === 0) return "off";
      if (v === 255) return "silent";
      const pos = ((v - 1) / 254) * 5;
      if (pos > 4) return `pulse ${Math.round(0.5 * (1 - (pos - 4)) * 100)}%`;
      return OSC_NAMES[Math.round(pos)]!;
    },
  },
  { key: "fm", label: "FM", describe: (v) => (v === 0 ? "off" : ["soft", "bell", "metal", "clangorous", "clangorous"][Math.floor(((v - 1) / 254) * 4.99)]!) },
  { key: "reso", label: "RESO", describe: (v) => (v === 0 ? "off" : nearest(RESO_NAMES, v)) },
  { key: "pluck", label: "PLUCK", describe: (v) => (v === 0 ? "off" : nearest(PLUCK_NAMES, v)) },
  {
    key: "noise", label: "NOISE",
    describe: (v) => (v === 0 ? "off" : v < 50 ? "pink" : v <= 100 ? "white" : `crush ${Math.round(((v - 100) / 155) * 100)}%`),
  },
  {
    key: "env", label: "ENV",
    describe: (v) => {
      const s = envShape(v);
      return `${s.attack < 0.01 ? "<10" : Math.round(s.attack * 1000)}ms ↗ ${Math.round(s.decay * 1000)}ms ↘`;
    },
  },
];

let patch: Patch = { ...DEFAULT_PATCH };
const player = new SynthPlayer();
const codeEl = $<HTMLInputElement>("code");
const noteEl = $<HTMLInputElement>("note");
const autoEl = $<HTMLInputElement>("auto");

// ---- sliders
const rows = new Map<SliderKey, { row: HTMLElement; input: HTMLInputElement; val: HTMLElement; desc: HTMLElement }>();
for (const s of SLIDERS) {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `<label for="s-${s.key}">${s.label}</label>
    <input id="s-${s.key}" type="range" min="0" max="255" step="1" />
    <span class="val"></span><span class="desc"></span>`;
  const input = row.querySelector("input")!;
  input.addEventListener("input", () => {
    patch[s.key] = Number(input.value);
    refresh();
  });
  input.addEventListener("change", () => { if (autoEl.checked) trigger(); });
  rows.set(s.key, { row, input, val: row.querySelector(".val")!, desc: row.querySelector(".desc")! });
  $("sliders").append(row);
}

// ---- bipolar knobs under ENV
type KnobKey = "envVol" | "envPitch";
const knobUpdaters = {} as Record<KnobKey, (v: number) => void>;
const knobBox = document.createElement("div");
knobBox.className = "knobs";
for (const [key, label] of [["envVol", "VOL"], ["envPitch", "OSC"]] as const) {
  const box = document.createElement("div");
  box.className = "knobbox";
  box.innerHTML = `<svg width="56" height="56" viewBox="-28 -28 56 56">
      <circle r="20" fill="none" stroke="var(--line)" stroke-width="4" />
      <path fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" />
      <line y1="-6" y2="-17" stroke="var(--text)" stroke-width="2.5" stroke-linecap="round" />
    </svg><output></output>${label}`;
  const svg = box.querySelector("svg")!, arc = box.querySelector("path")!, tick = box.querySelector("line")!;
  const out = box.querySelector("output")!;
  const pt = (deg: number) => [20 * Math.sin((deg * Math.PI) / 180), -20 * Math.cos((deg * Math.PI) / 180)] as const;
  knobUpdaters[key] = (v) => {
    const a = (v / 127) * 135;
    tick.setAttribute("transform", `rotate(${a})`);
    const [x, y] = pt(a);
    arc.setAttribute("d", v === 0 ? "" : `M 0 -20 A 20 20 0 0 ${v > 0 ? 1 : 0} ${x.toFixed(2)} ${y.toFixed(2)}`);
    out.textContent = v === 0 ? "0" : (v > 0 ? "+" : "") + Math.round((v / 127) * 100);
  };
  let drag: { y: number; v: number } | null = null;
  svg.addEventListener("pointerdown", (e) => { svg.setPointerCapture(e.pointerId); drag = { y: e.clientY, v: patch[key] }; });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    patch[key] = Math.max(-127, Math.min(127, Math.round(drag.v + (drag.y - e.clientY) * (e.shiftKey ? 0.4 : 1.4))));
    refresh();
  });
  const end = () => { if (drag) { drag = null; if (autoEl.checked) trigger(); } };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => { patch[key] = 0; refresh(); if (autoEl.checked) trigger(); });
  knobBox.append(box);
}
const envRow = rows.get("env")!.row;
const wrap = document.createElement("div");
wrap.className = "envwrap";
envRow.replaceWith(wrap);
wrap.append(envRow, knobBox);

// ---- scope: output waveform with the envelope outlined behind it
const scope = $<HTMLCanvasElement>("scope");
const g = scope.getContext("2d")!;
function drawScope() {
  const w = scope.width, h = scope.height, mid = h / 2;
  g.clearRect(0, 0, w, h);
  const data = renderPatch(patch, { sampleRate: player.ctx.sampleRate });
  const env = envShape(patch.env);
  const dur = data.length / player.ctx.sampleRate;
  g.lineWidth = 1.5;
  const trace = (fn: (t: number) => number, color: string) => {
    g.beginPath();
    for (let x = 0; x < w; x++) {
      const y = mid - fn((x / (w - 1)) * dur) * (mid - 8);
      if (x) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.strokeStyle = color;
    g.stroke();
  };
  if (patch.envVol !== 0) {
    const a = Math.abs(patch.envVol) / 127;
    const gain = (t: number) => 1 - a + a * (patch.envVol > 0 ? envValue(env, t) : 1 - envValue(env, t));
    trace(gain, "#ffffff2a");
    trace((t) => -gain(t), "#ffffff2a");
  }
  if (patch.envPitch !== 0) {
    const sign = Math.sign(patch.envPitch);
    g.setLineDash([4, 4]);
    trace((t) => sign * envValue(env, t) * 0.9, "#7aa2ffaa");
    g.setLineDash([]);
  }
  g.strokeStyle = "#ffb454";
  g.lineWidth = 1;
  g.beginPath();
  const spp = data.length / w;
  for (let x = 0; x < w; x++) {
    let lo = 1, hi = -1;
    const a = Math.floor(x * spp), b = Math.max(a + 1, Math.floor((x + 1) * spp));
    for (let i = a; i < b && i < data.length; i++) { const v = data[i]!; if (v < lo) lo = v; if (v > hi) hi = v; }
    g.moveTo(x + 0.5, mid - hi * (mid - 8));
    g.lineTo(x + 0.5, mid - lo * (mid - 8));
  }
  g.stroke();
}

// ---- state <-> UI
function refresh(skipCode = false) {
  patch = clampPatch(patch);
  for (const s of SLIDERS) {
    const r = rows.get(s.key)!, v = patch[s.key];
    r.input.value = String(v);
    r.val.textContent = String(v);
    r.desc.textContent = s.describe(v);
    r.row.classList.toggle("off", v === 0);
  }
  knobUpdaters.envVol(patch.envVol);
  knobUpdaters.envPitch(patch.envPitch);
  noteEl.value = String(patch.note);
  $("noteName").textContent = noteName(patch.note);
  if (!skipCode) {
    codeEl.value = encodePatch(patch);
    codeEl.classList.remove("invalid");
  }
  drawScope();
}

function trigger(note = patch.note) {
  player.play(patch, note, undefined, 0.8);
}

noteEl.addEventListener("input", () => { patch.note = Number(noteEl.value); refresh(); });
noteEl.addEventListener("change", () => { if (autoEl.checked) trigger(); });
codeEl.addEventListener("input", () => {
  const p = decodePatch(codeEl.value);
  codeEl.classList.toggle("invalid", !p && codeEl.value.trim() !== "");
  if (p) { patch = p; refresh(true); }
});
codeEl.addEventListener("change", () => { if (decodePatch(codeEl.value)) { refresh(); trigger(); } });
$("copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(codeEl.value); } catch { codeEl.select(); document.execCommand("copy"); }
  $("copy").textContent = "copied";
  setTimeout(() => ($("copy").textContent = "copy"), 900);
});
$("play").addEventListener("click", () => trigger());
$("reset").addEventListener("click", () => { patch = { ...DEFAULT_PATCH }; refresh(); trigger(); });
$("random").addEventListener("click", () => {
  const r = (n: number) => Math.floor(Math.random() * n);
  const on = () => (Math.random() < 0.45 ? 0 : 1 + r(254));
  patch = clampPatch({
    osc: on(), fm: on(), reso: on(), pluck: on(), noise: Math.random() < 0.7 ? 0 : 1 + r(254),
    env: r(256), envVol: Math.random() < 0.8 ? 127 - r(40) : r(255) - 127,
    envPitch: Math.random() < 0.5 ? 0 : r(255) - 127, note: patch.note,
  });
  if (!patch.osc && !patch.fm && !patch.reso && !patch.pluck && !patch.noise) patch.osc = 1 + r(150);
  refresh();
  trigger();
});

const KEYS = "awsedftgyhujkolp;";
addEventListener("keydown", (e) => {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.activeElement === codeEl) return;
  if (e.code === "Space") { e.preventDefault(); trigger(); return; }
  const i = KEYS.indexOf(e.key.toLowerCase());
  if (i >= 0) trigger(Math.min(127, patch.note + i));
});

refresh();
(window as unknown as { synth: unknown }).synth = { get patch() { return patch; }, player };
