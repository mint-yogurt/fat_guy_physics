# fat_guy_physics — design

Working document. The priority is a fun prototype, not a fixed design. For
build instructions and status see [README.md](README.md).

> **Old version note.** Voxels and digging belonged to an earlier version of this
> game. The game is **not** doing voxels: the ground is a smooth low-poly
> heightfield. Explosions and big impacts may carve craters out of it later, but
> not as voxels, and that is not promised.

## Overview

A multiplayer physics sandbox, played in the browser. Players roll around
a world, throw things, and build simple mechanical contraptions.
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

The world is procedurally generated terrain, drawn as a smooth low-poly
heightfield: a lattice with a vertex every 0.8 m, in 3.2 m tiles. It does not
change, and there is no digging or tunneling. Hills, cliffs and bluffs come from
the generator; the physics happens on top of the ground, not in it. Explosions
and large impacts might carve craters out of it later, but not as voxels.

## Construction

Simple machines, not detailed buildings: beams, planks, wheels, hinges,
ropes, springs, axles, barrels, crates, explosives — enough for catapults,
bridges, launchers and traps. Collected material becomes physics objects
(counterweights, boulders, snowballs) rather than being placed back into the
ground.

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
- **Forest** — the third region (the code still calls it `Biome.Plain`): flat,
  gently hilly, and big cartoony multi-tiered bluffs. Broadleaf trees, with
  huts to break open; chests, a loot table, a bigger tree, shrubs, thin grass
  and vines are planned.

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

Extracting resources from the ground itself is not a goal: resources are things
lying on it, in containers, or knocked off trees and snowmen.

## Visual direction

Nintendo 64. The 3D scene is rendered at a low internal resolution (320x240
at 4:3 by default, 480 lines as an option), scaled up to the window with nearest
sampling, with a light horizontal smear and a 5-bit-per-channel ordered dither,
so the pixels are chunky. Textures are small and blurry (nearest, no mipmaps; the
ground uses the N64's 3-point filter). Low-poly models, vertex-colour lighting,
and a short fog that hides the load distance. The HUD and UI stay sharp on top.
No PS1-style vertex wobble or affine warping: the N64 did not have them.
Possible later: bloom and mild colour bleed.

## Technical direction

TypeScript end to end, so client and server share the simulation.

- three.js `WebGPURenderer`, falling back to WebGL2.
- Jolt (`jolt-physics`) for rigid bodies.
- Heightfield ground in 3.2 m tiles (a vertex every 0.8 m; a finer lattice
  where an open grave has a pit), one layer of tiles high; generation and
  meshing on a Web Worker pool with transferable buffers. Collision samples
  the same surface.
- Fixed-timestep simulation with render interpolation.
- Zero-allocation frame loop.
- Node + ws authoritative server, with world changes (trees, props, pieces) replicated.
