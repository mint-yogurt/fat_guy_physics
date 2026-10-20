# fat_guy_physics — design

Working document. The priority is a fun prototype, not a fixed design. For
build instructions and status see [README.md](README.md).

## Overview

A multiplayer physics sandbox, played in the browser. Players roll around
a deformable world, throw things, and build simple mechanical contraptions.
Multiplayer interaction and emergent physics *are* the gameplay. Not a
survival game.

- Authoritative server; the simulation is shared code and runs identically on
  both sides.
- Physics-driven gameplay; co-op and PvP come out of the same mechanics.
- Simple construction.
- Stylized low-poly look.

## Physics

The primary system: rolling objects, moving platforms, seesaws, ramps,
swinging ropes, collapsing structures, explosions. Interesting situations
should emerge rather than be scripted.

## The ground

The world is procedurally generated voxel terrain (~10 cm voxels). It is
deformable: impacts and explosions knock chunks out of it and send them
flying, and the rest can collapse or fall. Digging and tunneling are not a
focus.

## Construction

Simple machines, not detailed buildings: beams, planks, wheels, hinges,
ropes, springs, axles, barrels, crates, explosives — enough for catapults,
bridges, launchers and traps. Collected material becomes physics objects
(counterweights, boulders, snowballs) rather than being placed back voxel by
voxel.

## Players

Round, soft characters: a big spherical torso, stubby limbs, a spherical
head. No ragdolls — players roll. **Ragball mode** tucks the player into a
sphere for fast, momentum-based travel; WASD only lightly steers.

Customization is limited: name, face, shirt colour, skin colour.

No hunger or thirst, health regenerates, combat is not the focus. Progression
unlocks new tools and construction pieces rather than raising power.

## World

Layered fractal noise. The world is made of holiday-themed regions —
Christmas and Halloween first, more may follow.

A region is a weight, not a flag: a low-frequency noise field gives each
column a blend strength, and ground colour, sky, light and weather all read
it, so a region fades in over ~20 m instead of starting at a line.

- **Christmas** — continuous snow, with a blizzard every few minutes that cuts
  visibility to a few metres. Relatively flat, with gentle rolling hills.
  Snowmen (a source of sticks) and presents (containers) are scattered about.
- **Halloween** — permanent spooky night: dark, but still readable. Flat
  sections, with cliffs jutting out of them. Tombstones, and graves set into
  the ground: most are covered with topsoil, some are open, and a few lean.
  Both kinds can hold loot.
- **Unnamed third region** — flat, gently hilly, and big cartoony multi-tiered
  bluffs. Still to be named and given a purpose.

### Verticality

The player does not jump up cliffs; cliffs and bluffs are walls. Getting up to
what is on top of them is part of progression, and is done by building
something to climb.

### Scatter and the generation sheet

What spawns in a region, and how often (common, uncommon, rare), is a table
per region in one file, `generationSheet.ts`, as are the terrain shape and
what each object yields or holds. That is also how a resource is added to
something: eggnog cartons in the Christmas presents is one row. Pre-made
generative structures are planned: they need flat ground, and resources and
objects cluster around them.

Extracting resources from the ground itself is not a goal for now; digging
machines or shovels may come later.

## Visual direction

Chunky voxel ground, low-poly models, vertex colours where practical, low
texture memory, simple shaders. Mild post-processing under consideration:
slight texture filtering like late-90s hardware, subtle chromatic aberration,
mild colour bleed.

## Technical direction

TypeScript end to end, so client and server share the simulation.

- three.js `WebGPURenderer`, falling back to WebGL2.
- Jolt (`jolt-physics`) for rigid bodies.
- Chunked voxel terrain with greedy meshing; generation and meshing on a Web
  Worker pool with transferable buffers.
- Fixed-timestep simulation with render interpolation.
- Zero-allocation frame loop.
- Node + ws authoritative server, with terrain changes replicated.
