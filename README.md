# fat_guy_physics
stupid physics voxel game

See [DESIGN.md](DESIGN.md) for the design document and roadmap.

## Building

The game is being ported to a browser client (TypeScript + three.js +
`jolt-physics`); see [the port plan](#web-port) below. Both builds currently
live in this repo and share the `assets/` tree.

### Web client (the target)

Requires Node 20+ (developed on 24 LTS). From the repo root:

```sh
npm install
npm run dev
```

Then open http://localhost:5173. Append `?gl` to the URL to force the WebGL2
backend instead of WebGPU — useful for telling "broken everywhere" apart from
"broken on one backend".

Controls are a free-flying debug camera until the player controller lands at
M4: click to capture the mouse, WASD to fly, Space/C for up/down, Shift to
boost. `?radius=N` overrides the chunk load radius — the initial load is
synchronous until M3, so `?radius=2` is worth it while iterating on anything
that isn't streaming itself.

```sh
npm run typecheck   # tsc --build across the workspace
npm run test        # vitest
npm run build       # static bundle into packages/client/dist
```

### Native build (the reference)

Requires CMake 3.21+ and a C++20 compiler. Dependencies (GLFW, GLM) are fetched
automatically at configure time via CMake FetchContent — no package manager
(vcpkg/apt) setup required.

The native build is retained as the **reference implementation** the port is
verified against, not as a parallel target — see [Web port](#web-port).

### Linux

GLFW needs X11 development headers to build:

```sh
sudo apt-get install cmake ninja-build xorg-dev
```

Then:

```sh
cmake -B build -G Ninja
cmake --build build
./build/fatguyphysics
```

### Windows 10

Install [CMake](https://cmake.org/download/) and Visual Studio 2022 (with the
"Desktop development with C++" workload). No extra dependencies needed.

```powershell
cmake -B build
cmake --build build --config Debug
build\Debug\fatguyphysics.exe
```

## Web port

The game is moving to the browser — playable with no download, single-player
and multiplayer. The stack is TypeScript + three.js (`WebGPURenderer`, which
falls back to WebGL2 on its own) + `jolt-physics`, which is the official
Emscripten build of **the same Jolt** the C++ uses, so the physics layer ports
near 1:1.

Layout: an npm workspaces monorepo under `packages/` — `@fgp/shared` (the
simulation; no three.js, no DOM, no browser APIs, because this is what the
authoritative server will run), `@fgp/client` (Vite + three.js), and later
`@fgp/server` (Node + ws).

Milestones, in order. Each one is runnable and visually verifiable:

- [x] **M0** Toolchain — monorepo, Vite, pinned three.js, backend readout
- [x] **M1** One chunk from the real generator, main thread + golden-data check
- [x] **M2** Fly camera + synchronous chunk streaming
- [x] **M3** Web Worker pool with transferable buffers
- [ ] **M4** Player controller, collision, the fixed-timestep frame loop
- [ ] **M5** Raycast (redesigned) + scoop
- [ ] **M6** Trees + chup + the canopy-size fix
- [ ] **M7** Jolt WASM + falling bodies
- [ ] **M8** Oriented-body collision (replaces snap-on-sleep)
- [ ] **M9** Items — **parity with the native build**
- [ ] **M10** DOM UI — hotbar, controls legend, character create
- [ ] **M11** Player rig + animation
- [ ] **M12** Post-processing
- [ ] **M13** World generation + biomes
- [ ] **M14** Multiplayer

### Golden-data verification

The native C++ build is kept as the **reference implementation**. A
golden-data dump is what the ported TypeScript is asserted against, so "it
runs" and "it behaves the same" stay separate questions.

```sh
bash tools/golden/dump-golden.sh   # regenerate tools/golden/golden.json
npm test                           # assert the TS port against it
```

The dumper compiles headlessly against the real voxel sources (no GL, no
GLFW, no Jolt) with any C++17 compiler, and **extracts** `hash32`/`hashFloat`
straight out of `Vegetation.cpp` rather than copying them — a golden test
built on a hand-copied function can't catch a transcription error, which is
the entire thing it exists to catch.

Currently covered: 225 hash tuples, 84 surface-height samples including
negative coordinates, and 8 chunks' voxel contents plus complete greedy-mesh
vertex buffers. A collision trace joins them at M4.

Regenerating `golden.json` to make a failing test pass defeats the point —
if a test fails, the TypeScript is wrong until proven otherwise.

## Development Roadmap

See the [Development Roadmap](DESIGN.md#development-roadmap-readme-added-to-as-each-step-gets-worked-on) section of DESIGN.md.

The phase list below describes the **native build**, which is feature-complete
through Phase 4. It doubles as the parity checklist for the port's M9.

### Phase 0 — Project setup

- [x] Repository
- [x] Build system (CMake + FetchContent)
- [x] Rendering (OpenGL 3.3 core, GLFW + glad)
- [x] Camera
- [x] Basic application framework

### Phase 1 — Voxel terrain

- [x] Chunk storage (32³ voxels, ~10cm each)
- [x] Procedural generation (heightmap via layered/fractal Perlin noise)
- [x] Meshing (greedy meshing, vertex-colored by material)
- [x] Streaming (radius around the camera, load/unload on chunk-boundary crossing; the initial load is synchronous, but later loads run on a background worker thread pool — generation/meshing/vegetation happen off the main thread, and only the GPU upload happens on it — so crossing a boundary no longer stalls the frame)

### Phase 2 — Terrain editing

- [x] Scoop mechanic (hold left mouse to dig a sphere at the crosshair; ramps up to full radius over a few ticks of holding still on one spot)
- [x] Material hardness (bare-handed digging only removes soft materials; Rock/Granite/Ice need a future tool)
- [x] Mesh regeneration (touched chunks re-meshed and re-uploaded in place after each dig)
- [x] Collision updates (dig raycast reads live voxel data directly, no separate/stale collision structure)

### Phase 3 — Player controller

- [x] Walking (WASD, AABB collision, step-up assist for small ledges)
- [x] Jumping (Space, ground-only)
- [x] Rolling (rolling-without-slipping orientation, only while in Ragball mode)
- [x] Ragball mode (R to toggle, sphere collision, momentum/gravity-driven — WASD only lightly steers, not a direct speed control)

Also added: first/third-person camera toggle (V), live FOV adjustment (-/=), per-face baked lighting (fixes flat/blended terrain shading), FPS/FOV/crosshair-distance HUD readout plus a worst-frame-time-per-second readout (WORST, in ms, unclamped/unsmoothed — for spotting stalls the heavily-smoothed FPS number can't show), click-to-capture mouse with fullscreen-by-default window (sidesteps window-manager resize/cursor-capture conflicts).

### Phase 4 — Trees, felled logs, item pickups

- [x] Trees (voxelized trunk + canopy, chup severs the trunk into a real falling/settling Jolt body)
- [x] Chup on foliage (clears Leaf same as Wood, not trunk-only)
- [x] Felled logs stay interactable indefinitely (raycast/scoop/chop, recursive re-severance into smaller pieces)
- [x] Item pickups (leaf/stick billboards, gravity-fall from the scoop/chup point, hover-bob once landed)
- [x] Foliage-impact shatter (a settled log's canopy touching terrain or another log clears and drops pickups)
- [x] Walkable felled logs (player can stand on a settled log/canopy like terrain)

**Known temporary/stopgap pieces, not final design:**
- Walkable logs work via "snap-on-sleep": a settled log's rotation snaps to the nearest of 24 axis-aligned orientations so it can reuse terrain's integer-voxel collision. This only works for logs that land close to square with the world grid — a log resting at a real off-axis tilt or on a slope stays walk-through. The real fix (arbitrary-orientation player collision) is unbuilt; see the comment on `World::isSolidIncludingSnappedLogs`.
- Floating terrain voxels (dug out from underneath, left hanging with no support check) are a known, still-open gap — no connectivity/support analysis exists yet. A named no-op seam for it lives in `World::digSphere`.
- The raycast "what did I hit" result (`SceneHit`/`ActionHit`) is a `std::variant` that enumerates only what's currently hittable rather than always resolving to something in range — flagged in code as bad long-term design, not yet replaced.

