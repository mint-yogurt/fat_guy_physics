# fatguyphysics

**Working title.** Early design document — nothing here is final. The
priority is a fun prototype, not adherence to a fixed design.

For build instructions, milestones and known gaps, see
[README.md](README.md).

---

# Overview

A multiplayer voxel physics sandbox, played in the browser with no download.

The world is procedurally generated deformable voxel terrain. Players
excavate it, throw physics objects around, and build simple mechanical
contraptions. Multiplayer interaction and emergent physics are meant to be
the gameplay, not a layer on top of it.

Explicitly **not** a survival game.

Goals:

- Authoritative dedicated server; the simulation runs identically on both sides.
- Procedural, modifiable voxel terrain.
- Physics-driven gameplay.
- Co-op and PvP out of the same mechanics.
- Simple construction.
- Stylized low-poly presentation.

---

# Design goals

## Deformable terrain

Terrain is editable at runtime. Excavation removes small volumes rather than
fixed cubes, so holes come out rounded and irregular. Voxels are ~10 cm.

Materials have hardness, and harder ones need better tools. Rough
progression: Sand, Snow, Dirt, Clay, Gravel, Rock, Granite, Ice.

## Physics

The primary system. Rolling objects, falling terrain, explosions, moving
platforms, seesaws, ramps, swinging ropes, collapsing structures. Interesting
situations should emerge rather than be scripted.

## Construction

Simple machines, not detailed buildings. Beams, planks, wheels, hinges,
ropes, springs, axles, chains, barrels, crates, explosives — enough to make
catapults, bridges, elevators, launchers and traps.

## Multiplayer

Excavate under someone's structure. Launch each other with improvised
machines. Destroy supports, trigger collapses, share projects. Co-op and PvP
should fall out of the same toolkit.

---

# Player

Players are round, soft characters — a big spherical torso with stubby chubby
limbs and a spherical head. Not boxes. The authored model lives at
`assets/meshes/playermodel_v2.glb` (Z up, front is +X, T-posed, separate
head/arm/leg parts for animation).

No ragdolls — players roll. **Ragball mode** tucks the player into a sphere
for faster, momentum-based traversal; WASD only lightly steers. Rotation is
about the torso's centre of mass.

Customization is intentionally limited: name, face, shirt colour, skin
colour.

---

# World generation

Layered Perlin/fractal noise. Biome transitions blend gradually with noise
rather than snapping at a border.

Thematic direction: a world made of holiday-themed regions. Christmas and
Halloween first; more may follow.

A region is a weight, not a flag: a low-frequency noise field gives each
column a blend strength, and ground colour, sky, light level and weather all
read it, so a region fades in over ~20m rather than starting at a line.
Biomes deliberately place no different *material* -- only colour -- so the
material list can still be scrapped.

Christmas snows continuously and throws a blizzard every few minutes that
cuts visibility to a few metres. Halloween is permanent spooky night: dark
enough to feel like night, light enough to still read the terrain.

---

# Progression

No hunger, no thirst, health regenerates, combat is not the focus.
Progression unlocks interactions rather than raising power: new tools,
construction components, materials, mechanical systems.

---

# Materials

Excavation yields usable material. Rather than placing it back voxel by
voxel, it converts into physics objects — counterweights, boulders,
snowballs, sandbags, construction pieces. Implementation undecided.

---

# Visual direction

Chunky voxel terrain, low-poly models, vertex colours where practical, low
texture memory ([quod textures](https://daivuk.itch.io/quod-textures)),
atlases where they help, simple shaders.

Mild post-processing, under consideration: slight texture filtering like
late-90s hardware, subtle chromatic aberration, mild colour bleed.

---

# Technical direction

TypeScript end to end — the simulation is shared verbatim between client and
server, which is the whole reason the port happened.

- three.js `WebGPURenderer`, falling back to WebGL2 on its own.
- Jolt (`jolt-physics`, the Emscripten build) for rigid bodies.
- Chunk-based voxel terrain, greedy meshing, face and frustum culling.
- Chunk generation and meshing on a Web Worker pool with transferable
  buffers; only the GPU upload touches the main thread.
- Fixed-timestep simulation with render interpolation, so physics is
  deterministic and frame rate independent.
- Zero-allocation frame loop: no garbage means no GC pauses mid-roll.
- Authoritative server (Node + ws), with terrain edits replicated.

Optimization is considered as it goes, not postponed.
