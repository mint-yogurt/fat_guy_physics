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

