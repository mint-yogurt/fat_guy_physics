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
- `?radius=N` — override the chunk load radius, to tell "slow because there
  is a lot of terrain" apart from "slow for some other reason".

## Layout

npm workspaces monorepo under `packages/`:

- **`@fgp/shared`** — the simulation. No three.js, no DOM, no browser APIs,
  because this is what the authoritative server will run.
- **`@fgp/client`** — Vite + three.js (`WebGPURenderer`, which falls back to
  WebGL2 on its own) + `jolt-physics`, the official Emscripten build of the
  same Jolt the old native build used.
- **`@fgp/server`** — Node + ws. Not written yet (M14).

`src/` and `CMakeLists.txt` are the original C++ build, kept only as the
reference implementation the port is verified against. It is not a build
target any more.

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
- [ ] **M13** World generation + biomes
- [ ] **M14** Multiplayer

### Known gaps

- Floating terrain voxels: dig from underneath and the material above hangs
  there. No connectivity or support analysis exists yet.
- Debris particles and foliage-impact shatter are not ported.
- Item icons (`assets/icons/`) and face textures
  (`assets/textures/faces/`) exist but are unused — character create's face
  option currently changes nothing.
- The walking collider is an AABB, not a swept capsule.

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
