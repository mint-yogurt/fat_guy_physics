# fat_guy_physics

Stupid physics voxel game. Browser-playable, no download, single-player and
multiplayer. See [DESIGN.md](DESIGN.md) for the design document.

## Running it

Needs Node 20+ (developed on 24). From the repo root:

```sh
npm install
npm run dev
```

Then open http://localhost:5173.

```sh
npm run typecheck   # tsc --build across the workspace
npm run test        # vitest
npm run build       # static bundle into packages/client/dist
```

### Controls

Click to capture the mouse. WASD walk, Space jump, hold left mouse to dig,
right mouse to chop, R toggles Ragball, V first/third person, `-`/`=` FOV,
1-9 hotbar.

### URL flags

- `?gl` — force the WebGL2 backend instead of WebGPU, to tell "broken
  everywhere" apart from "broken on one backend".
- `?radius=N` — override the chunk load radius. Defaults to 12 chunks
  (38m); it was 6 before biomes landed. Also tells "slow because there is a
  lot of terrain" apart from "slow for some other reason".

## Layout

npm workspaces monorepo under `packages/`:

- **`@fgp/shared`** — the simulation. No three.js, no DOM, no browser APIs,
  because this is what the authoritative server will run.
- **`@fgp/client`** — Vite + three.js (`WebGPURenderer`, which falls back to
  WebGL2 on its own) + `jolt-physics`, the official Emscripten build of the
  same Jolt the old native build used.
- **`@fgp/synth`** — the sound engine; see [Synth](#synth) below. Standalone,
  no dependencies, not yet wired into the game.
- **`@fgp/server`** — Node + ws. Not written yet (M14).

`src/` and `CMakeLists.txt` are the original C++ build, kept only as the
reference implementation the port is verified against. It is not a build
target any more.

## Synth

`packages/synth` is a small custom synth for sound effects and the soundtrack.
It has no dependencies and its DSP core touches no browser API, so the
`src/` folder can be copied into another project as is. To try it:

```sh
npm run synth       # test page on http://localhost:5174
```

A sound is six sliders (0-255), two knobs and a note:

| Control | 0 | Then |
| --- | --- | --- |
| **OSC** | off | sine, triangle, sharktooth, saw, square, then the pulse narrowing until it is silent at 255 |
| **FM** | off | soft, bell, metal bar, clangorous (ratio and depth are mapped internally; the FM brightness follows ENV) |
| **RESO** | off | struck modal resonator: woodblock, thud, machinery, clang, glass |
| **PLUCK** | off | Karplus-Strong: pluck, elastic boing, buzzing wire, rain on tin |
| **NOISE** | off | pink, white, then bit and rate crushing; past white the crush clock follows the note's pitch |
| **ENV** | instant attack, 40ms decay | longer decays, slewed attack, a smooth sine hump at 127, then slow attack with quick decay |

The ENV knobs are bipolar attenuverters: **VOL** routes the envelope to
volume (negative inverts, 0 is a flat gate for the envelope's length) and
**OSC** routes it to the pitch of everything pitched: OSC, FM, RESO and
PLUCK (up to 4 octaves, tapered so small values are subtle). PLUCK's
excitation burst comes from the NOISE slider's character, or plain white if
NOISE is off, so with both on you also hear the continuous noise.

A struck sound (RESO, PLUCK) with VOL on and a slow-attack ENV is silent,
because the hit lands while the envelope is still at zero. Set VOL to 0 to
let it ring.

### The code

A patch is shared as a 16-character code in four groups, such as
`0400-1J00-F3Z7-YF0R`: nine bytes (six sliders, two knobs, note) plus a CRC-8
byte, in Crockford base32. Case, dashes and spaces are ignored, `I L O` read
as `1 1 0`, and a typo fails the checksum. Rendering is deterministic (fixed
noise seeds), so a code always produces the same sound. The note is in the
code but callers can override it per play, which is how a MIDI player would
use it. Changing the format later invalidates old codes.

### API

```ts
import { SynthPlayer, decodePatch, renderPatch } from "@fgp/synth";

const patch = decodePatch("0400-1J00-F3Z7-YF0R")!;   // null if invalid
const player = new SynthPlayer();                     // wraps an AudioContext
player.play(patch);                                   // or play(patch, midiNote, when)
const samples = renderPatch(patch, { note: 72 });     // Float32Array, no Web Audio needed
```

`renderPatch` and the code functions are pure, so they also run in a worker
or Node (the tests do). `SynthPlayer` renders to an AudioBuffer, caches it,
and plays one-shots through `player.bus`, the place to hook in the reverb
(not written yet). The tuning tables (FM ratios, RESO and PLUCK profiles,
envelope times) are at the top of `src/dsp.ts`.

## Milestones

Each one is runnable and visually verifiable.

- [x] **M0** Toolchain — monorepo, Vite, pinned three.js, backend readout
- [x] **M1** One chunk from the real generator + golden-data check
- [x] **M2** Fly camera + synchronous chunk streaming
- [x] **M3** Web Worker pool with transferable buffers
- [x] **M4** Player controller, collision, fixed-timestep frame loop
- [x] **M5** Raycast + scoop
- [x] **M6** Trees + chup + the canopy-size fix
- [x] **M7** Jolt WASM + falling bodies
- [x] **M8** Oriented-body collision — felled logs are walkable at any angle
- [x] **M9** Items — pickups, inventory, hotbar gating
- [x] **M10** DOM UI — hotbar, controls legend
- [x] **M11** Player rig + animation + character create
- [ ] **M12** Post-processing
- [~] **M13** Biome field, ground colour, sky/light, snow — vegetation pending
- [ ] **M14** Multiplayer

### Known gaps

- Floating terrain voxels: dig from underneath and the material above hangs
  there. No connectivity or support analysis exists yet.
- Debris particles and foliage-impact shatter are not ported.
- Face textures (`assets/textures/faces/`) exist but are unused —
  character create's face option currently changes nothing. Item icons
  (`assets/icons/`) are used for dropped leaves and sticks only.
- The walking collider is an AABB, not a swept capsule.
- The r6 -> r12 load radius is unmeasured: the dev browser pane pins at
  exactly 30 FPS at both radii, so it caps the measurement rather than
  reporting it. Check FPS/WORST on real hardware before trusting the
  default.
- Each region has one authored tree (`worldgen/trees.ts`); the rest of
  its props — snowmen, pumpkins, cobwebs, buildings — are not in yet.
  `speciesForBiome` in `worldgen/vegetation.ts` is the one seam to change
  when they land.
- Tree sizes are set by `targetHeightMeters` per species, which scales the
  authored mesh to roughly the height the voxel trees it replaced stood at.
  The files themselves are five to seven times that; the numbers are a
  judgement call, not a measurement.
- A felled piece collides as a capsule the width of its trunk, so a
  toppled canopy is walked through rather than stood on.
- Trees are not solid to the player, only to the aiming raycast — as the
  voxel trees were.

## Golden-data verification

The native C++ build is the reference implementation. A golden-data dump is
what the TypeScript is asserted against, so "it runs" and "it behaves the
same" stay separate questions.

```sh
bash tools/golden/dump-golden.sh   # regenerate tools/golden/golden.json
npm test                           # assert the TS port against it
```

The dumper compiles headlessly against the real voxel sources (no GL, no
GLFW, no Jolt) and **extracts** `hash32`/`hashFloat` straight out of
`Vegetation.cpp` rather than copying them — a golden test built on a
hand-copied function can't catch a transcription error, which is the entire
thing it exists to catch.

Covered: 225 hash tuples, 84 surface-height samples including negative
coordinates, 8 chunks' voxel contents plus complete greedy-mesh vertex
buffers, and an 870-substep player trace (walking, jumping, diagonal
step-ups, a Ragball roll) recorded from the real Collision.cpp and Player.cpp
against a stub World.

Regenerating `golden.json` to make a failing test pass defeats the point. If
a test fails, the TypeScript is wrong until proven otherwise.
