# fatguyphysics

**Working title**

## Status

Early design document.

This document exists to record the current direction of the project. Nothing here should be considered final. Mechanics, implementation details, technology choices, art direction, and gameplay systems may change as development progresses. The priority is producing a fun prototype rather than adhering to a fixed design.

---

# Overview

fatguyphysics is a multiplayer voxel physics sandbox written in C++.

The world consists of procedurally generated deformable voxel terrain. Players can excavate terrain, manipulate physics objects, and construct simple mechanical contraptions. Multiplayer interaction and emergent physics are intended to be the primary source of gameplay.

The project is intentionally **not** being designed as a traditional survival game.

Current goals include:

* Dedicated server architecture.
* Cross-platform client.
* Procedurally generated voxel terrain.
* Terrain modification.
* Physics-driven gameplay.
* Cooperative and PvP multiplayer.
* Simple construction mechanics.
* Stylized low-poly presentation.

---

# Design Goals

The project should prioritize the following.

## Deformable terrain

Terrain should be editable at runtime.

Instead of removing fixed cubes, excavation removes small volumes of material, producing rounded or irregular holes.

Voxel size is currently planned at approximately 10 cm.

Materials have different hardness values.

Example material progression:

* Sand
* Snow
* Dirt
* Clay
* Gravel
* Rock
* Granite
* Ice

Harder materials require progressively better tools.

---

## Physics

Physics is the primary gameplay system.

Examples include:

* Rolling objects
* Falling terrain
* Explosions
* Moving platforms
* Seesaws
* Ramps
* Swinging ropes
* Collapsing structures

The intention is for interesting situations to emerge naturally rather than relying on scripted mechanics.

---

## Construction

Construction is centered around assembling simple machines rather than constructing detailed buildings.

Current object ideas include:

* Beams
* Planks
* Wheels
* Hinges
* Ropes
* Springs
* Axles
* Chains
* Barrels
* Crates
* Explosives

These components should be usable to build simple mechanical systems such as catapults, bridges, elevators, launchers, traps, and similar contraptions.

---

## Multiplayer

The game is intended primarily for multiplayer.

Both cooperative and PvP play should emerge naturally from the same mechanics.

Examples:

* Excavating beneath another player's structure.
* Launching players using improvised machines.
* Destroying supports.
* Triggering collapses.
* Sharing construction projects.

---

# Player

Players are represented by spherical characters with small arms and legs.

Instead of using ragdolls, players roll.

A dedicated "ragball" mode allows players to tuck into a sphere for faster rolling movement and momentum-based traversal.

Character customization is intentionally limited.

Current plans include:

* Face selection
* Shirt texture
* Skin color

---

# World Generation

Terrain is procedurally generated using layered noise.

Current techniques under consideration:

* Perlin noise
* Fractal noise

Biome transitions should blend gradually using noise rather than abrupt borders.

Current thematic direction is a world formed from multiple holiday-themed regions.

Initial regions:

* Christmas
* Halloween

Additional themes may be added later.

---

# Progression

No survival mechanics are currently planned.

Current assumptions:

* No hunger.
* No thirst.
* Health regenerates automatically.
* Combat is not the primary gameplay focus.

Progression should primarily unlock additional interactions rather than increase player power.

Examples:

* New tools
* New construction components
* New materials
* Additional mechanical systems

---

# Materials

Excavation produces usable material.

Instead of placing terrain voxel-by-voxel, collected material may be converted into physics objects.

Examples:

* Counterweights
* Boulders
* Snowballs
* Sandbags
* Construction pieces

Exact implementation remains undecided.

---

# Visual Direction

Current goals:

* Chunky voxel terrain.
* Low-poly models.
* Vertex colors where practical.
* Low texture memory usage.
* Texture atlases where appropriate.
* Simple shaders.
* Mild retro-inspired post-processing.

Current effects being considered:

* Slight texture filtering similar to late-1990s hardware.
* Subtle chromatic aberration.
* Mild color bleed.

These are presentation details only and may change.

---

# Technical Goals

Current implementation targets:

* C++
* Dedicated server
* OpenGL renderer (subject to change)
* Cross-platform
* Chunk-based voxel terrain
* Greedy meshing
* Face culling
* Frustum culling
* Efficient chunk updates
* Shared code between client and server where practical
* Live update - allowing changes to reflect during runtime

Optimization should be considered throughout development rather than postponed until later.

---

# Initial Prototype

The first milestone is intended to answer a single question:

Can terrain excavation be made responsive and satisfying?

Prototype requirements:

* Window
* Camera
* Procedural terrain
* Chunk generation
* Terrain meshing
* Terrain excavation
* Chunk rebuild after modification
* Collision updates

No additional gameplay systems are required until this is working.

---

# Development Roadmap (README added to as each step gets worked on)

## Phase 0

Project setup.

* Repository
* Build system
* Rendering
* Camera
* Basic application framework

## Phase 1

Voxel terrain.

* Chunk storage
* Procedural generation
* Meshing
* Streaming

## Phase 2

Terrain editing.

* Scoop mechanic
* Material hardness
* Mesh regeneration
* Collision updates

## Phase 3

Player controller.

* Walking
* Jumping
* Rolling
* Ragball mode

## Phase 4

Networking.

* Dedicated server
* Client synchronization
* Terrain replication
* Live-update support

## Phase 5

Physics objects.

* Rigid bodies
* Pick up
* Carry
* Throw
* Placement

## Phase 6

Construction.

* Beams
* Ropes
* Hinges
* Wheels
* Springs
* Snapping

## Phase 7

Gameplay systems.

* Explosions
* Chain reactions
* Additional tools
* Materials
* Objects

## Phase 8

Content.

* Biomes
* Creatures
* Assets
* Audio
* Polish
* Optimization

---

# Repository Organization (Tentative)

```
fatguyphysics/
├── client/
├── server/
├── shared/
├── engine/
│   ├── graphics/
│   ├── networking/
│   ├── physics/
│   ├── voxel/
│   ├── world/
│   └── util/
├── assets/
│   ├── models/
│   ├── shaders/
│   ├── textures/
│   └── audio/
├── tools/
├── third_party/
└── docs/
```

This layout is expected to change as the project grows.
