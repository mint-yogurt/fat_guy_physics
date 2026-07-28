# fat_guy_physics
stupid physics voxel game

See [DESIGN.md](DESIGN.md) for the design document and roadmap.

## Building

Requires CMake 3.21+ and a C++20 compiler. Dependencies (GLFW, GLM) are fetched
automatically at configure time via CMake FetchContent — no package manager
(vcpkg/apt) setup required.

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

## Development Roadmap

See the [Development Roadmap](DESIGN.md#development-roadmap-readme-added-to-as-each-step-gets-worked-on) section of DESIGN.md.

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

Known issues (to revisit):
- Player occasionally still gets stuck against a ledge or fails to jump over one — the step-up assist and jump/ground-probe timing have had two rounds of fixes but aren't fully reliable yet.
