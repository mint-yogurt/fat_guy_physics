# fat_guy_physics

A multiplayer physics sandbox that runs in the browser — no download. See
[DESIGN.md](DESIGN.md) for the design.

> **Old version note.** Voxels belonged to an earlier version of this game and
> are **not** being done. There is no voxel ground and no digging: the ground
> is a smooth low-poly heightfield mesh (see [The ground](#the-ground)).
> Explosions and big impacts may carve craters out of it later, but not as
> voxels, and that is not promised.

## Running it

Needs Node 20+.

```sh
npm install
npm run dev         # http://localhost:5173
```

```sh
npm run typecheck   # tsc --build across the workspace
npm run test        # vitest
npm run build       # static bundle into packages/client/dist
```

### Controls

Click to capture the mouse. WASD walk, Space jump, left mouse scoops (trees,
snowbanks and snowballs; it does nothing to bare ground), right
mouse **chups** (not "chops" -- chup is the game's word for it), E picks up
the item under the crosshair (hold it to hoover up a pile), R toggles
Ragball, V first/third person, `-`/`=` FOV, 1-8 hotbar, I inventory.

With a stick equipped: left mouse swings it like a sword (a swing is a chup,
so it fells trees too), hold right mouse to charge a spear throw and release
to throw. With xmas lights equipped: left mouse ties the first end, then the
other; right mouse runs another string on to reach further; E cancels.

With anything that can be placed equipped (a mat, a gift, a ladder, a log, a
plank, a sheet of plywood, a wheel): left mouse places it, the **scroll wheel**
turns it 45 degrees a notch, and holding **R** while moving the mouse turns it
freely (R is the Ragball key when nothing placeable is in hand). A log is also
bowled with left mouse, so a quick *tap* places it and *holding* bowls it. To
climb a ladder, walk into it facing it and keep W down; W and S go up and down,
look anywhere, Space jumps off.

### On-screen UI

Only the hotbar and what is relevant right now are shown:

- **Bottom right**, a keycap per button with its action under it, for
  whatever is in the hand (bare hands: LMB scoop, RMB chup; stick, log,
  snowball, trampoline, skateboard and xmas lights each have their own, and
  "hold" marks the ones that charge). The table is `controlHintsFor` in
  [`controlHints.ts`](packages/client/src/ui/controlHints.ts): a new item with
  a button action adds a case there.
- **Tab** toggles the debug readout (top left: FPS, position, tile counts and
  so on). It is hidden by default.
- While the mouse is free, a small "click to capture mouse" notice (or the
  reason pointer lock was refused) shows at the top. Esc still releases the
  mouse, as the browser forces it to; the pause menu that will sit behind it
  is not built yet.
- **M** opens the map. **WASD** pans it (the player stands still while it is
  open), the mouse wheel zooms, and there is no limit to zooming out: far out it
  samples every few map pixels, so it costs no more than the panel size
  (`ui/mapView.ts`). It opens centred on the player each time.
- The full control legend (WASD, E, M, R, V, FOV, slots) is kept in
  `index.html` as `#controls`, hidden. It is for menu > controls.

### URL flags

- `?gl` — force the WebGL2 backend instead of WebGPU.
- `?radius=N` — override the load radius in ground tiles (3.2 m each; default 12,
  about 38 m).
- `?res=480` — hi-res mode for the N64 look (`240`, the default, or `480`); remembered
  in `localStorage`. `?aspect=4:3|16:9|window` picks the picture shape, also remembered
  (see [Graphics](#graphics-the-n64-look)).
- `?save=0` — play without reading or writing the saved game (see [Saving](#saving)).
- `?reset=1` — throw the saved game away and start over (the flag removes itself
  from the address bar). Also how to get the debug kit back: it is only granted to a
  new game.

## Packages

npm workspaces under `packages/`:

- **`@fgp/shared`** — the simulation. No three.js, no DOM, no browser APIs,
  so the authoritative server can run it unchanged.
- **`@fgp/client`** — Vite + three.js (`WebGPURenderer`, falling back to
  WebGL2) + `jolt-physics`.
- **`@fgp/synth`** — sound engine. Played by the game through `packages/client/src/audio/` (every effect and where it fires: [sfx.md](sfx.md); `?audio=0` mutes); see its
  [README](packages/synth/README.md).
- **`@fgp/server`** — Node + ws. Not written yet.

## Status

Done: a smooth heightfield ground streamed in tiles through a worker pool, player controller and
collision, Jolt rigid bodies, trees you can fell and chup down into logs,
sticks and leaves, item pickups with E, a held stick you can swing or
throw, held items and their actions on the third-person character as well
as in first person, items and hotbar, player
rig and character create, biome field with ground colour, sky, light and
snow, per-region terrain height (rolling hills, cliffs, tiered bluffs), the
N64 look, ground textures, and
scattered props: snowmen, presents, tombstones and graves, and a
first-person arm that scoops and chops, and xmas lights: a tool-gun style
rope you tie to the world, with glowing bulbs that light their surroundings,
strung on some Christmas trees.

Next: pre-made generative structures (flat ground, with resources clustered
round them), the grave-topsoil tool, post-processing, multiplayer.

### TODO

- What the new items are for: **coal**, **metal**, **candy**, **goo**,
  **eggnog** and **mowden lightning** are in the game and in the Christmas
  loot (except goo, which is in no loot table yet), but only the can, goo and
  eggnog do anything, and only the can (-> metal) is an ingredient yet.
- The ladder (`ladder.glb`) is an item with no use yet; so are toobifers
  (2x4s), plywood, wheels and springs, beyond being crafting materials.
- **Spring shoes wear out**: they should break after a limited number of
  bounds. `SpringStride.bounds` already counts them and `wornOut` reads
  `SPRING_SHOES_LIFETIME`, which is infinite, so nothing breaks yet. Still to
  do: pick the lifetime, remember the wear on the item (a stack is only
  type + count today, so a worn pair needs somewhere to keep it), a break
  event with a sound and a puff, and a wear readout on the slot. The pair is
  also stackable like any item, which a pair with wear should not be.
- Crafting UI: putting one material in the boxes should list everything it can
  make from the recipes the player knows, with what each needs. For now the
  result box shows one recipe and a small `1/4` button cycles the rest
  (stub, see `items/crafting.ts`).
- Harvesting snow in the Christmas region, and snowball item controls
  (throw, roll like the log item).
- A visible map-viewing animation while the player is looking at the map
  (requires the map texture).
- Mesh + textures for: duct tape, CRT, metal, beer bottle, pumpkin,
  jack-o'-lantern.

### Trees, wood and items

Trees are where the first materials come from: **logs, sticks and leaves**.
All three go into the inventory (hotbar slots 2-8, then the 24-slot backpack).

### Placing things

Everything that can be placed is placed with **left mouse**. While one is
held, a see-through copy of it stands where it would go: **green** if it can be
put there, **red** if not (solid ground or a wall would be inside it, the
ground drops away too far under it, a mat, prop or tree is in the way, or you
are standing where it would go). A red click only plays the error sound. The
hand is shown empty in first person while you hold one (the ghost says where it
goes); third person, and so other players, still see it carried. (A log keeps
it in the hand: it is thrown too.)

**Turning what you place.** The scroll wheel steps its spin by 45 degrees (it
snaps to the grid first, so corners come out square). Hold **R** and move the
mouse to turn it freely: sideways spins it, up and down tilts it (the camera
holds still while R is down). The free turn is slightly sticky at multiples of
15 degrees, so level and square are easy to find by hand. The turn starts over
when you pick another item. A mat or a gift only spins (about up); a building
piece spins about whatever surface it is laid on and tilts away from it (see
[Building](#building)). The state is `shared/items/placementControl.ts`
(`PlacementOrientation`).

The rules are in `shared/items/placement.ts` (`PLACEMENTS` has one row per
placeable: footprint, height, how far the ground may fall away, whether it
faces you, whether to hide it in the first-person hand), the ghost in
`client/render/placementPreview.ts`. To make a new item placeable on the
ground (a mat, a gift) add a row, a ghost builder, and a case in `placeHeld` in
`main.ts`; the aiming, the green/red test and the preview follow. A thing that
is laid against surfaces at any angle (a ladder, a plank) is a building piece,
below, and needs neither the ghost nor the case.

### Building

Ladders, logs, 2x4s (`toobifer`), sheets of plywood and wheels are **building
pieces**: put anywhere there is a surface, at any angle, left in the world, and
built up into structures. This is the start of the "build with physics" system,
shaped so more pieces and fasteners can be added without special cases.

**Nothing is attached at authored points.** A piece is a box or a cylinder with
a pose, and anything touching anything is joined by the touching, found from the
shapes. A new piece is a row in `PIECE_SPECS` (`shared/items/building.ts`) and a
mesh row in `client/render/pieceMesh.ts`; it already stacks on, leans against and
hangs off everything else, including pieces that do not exist yet.

**Placing one.** You aim at a surface (terrain, a trunk, a prop or another piece);
the piece is laid with its *contact face* on it (a ladder's back, a plank's
underside, a log's side), its long way along the surface (up a wall; the way you
face on a floor), then spun and tilted by your turn of it, then slid out until
it just touches the aimed point whatever angle it ended up at: a tilted ladder
touches the wall with its top edge, it does not sink in. The whole volume is
tested for room (ground, trunk, prop, another piece or you in it makes it red).
`shared/items/buildPlan.ts` is all of that; nothing in it knows what a ladder is.

**Two states.** A piece that *grips* (a ladder) is **fixed** where you put it:
a static body, held for as long as something it touches is held (the ground, a
trunk, a prop, a loose piece at rest, or a fixed piece that is itself held). Chop
the tree it hangs on or pick up what it hangs on, and it
comes away and falls (`BuildField.looseOnes`, looked at once a second and straight
after any chop or pickup nearby). A **loose** piece (a log, a plank, plywood,
a wheel) is a Jolt rigid body: it drops, tumbles, lands and sleeps where it
stops, so a plank put on two logs is a plank on two logs, and it falls if
something under it goes. Only a piece at rest can be stood on (as with felled
logs). Walkable pieces are never thinner than 10cm so a foot cannot slip through
(`MIN_SOLID_THICKNESS`): plywood is a chunky slab and the mesh is stretched to match.
E picks a piece up again (and wakes whatever was resting on it).

**Hitting them.** Every piece near you is solid to things in flight, walkable or
not: thrown snowballs, rocks, cans, goo and the xmas lights' string stop on a
ladder or drape over a plank (`TrunkQuery.solids`, filled by the build system), and
a thrown stick bounces off one. Xmas lights tie to a piece at the spot aimed at
(`BuildPieceRopeBody`): the end goes where the piece goes, a loose piece is pulled
and turned by the string, and a fixed one stays put.

**Climbing.** A *rail* (`shared/sim/climb.ts`) is a line the player can hold: a
climbable piece's long axis, today a ladder's. Walk into a ladder facing it with
W held (within about a metre, in front of it) and you take hold: from then you
move only up and down it (W and S, 2.6 m/s), the body drawn in to the rungs and
the camera free (first or third person). Space lets go with a small hop away from
it and normal air control, so jumping to a ledge half way up works; going down the
bottom puts you on the ground; going up the top hops you over onto whatever
ledge is there (forward and up). Ladders are not solid to walk through; you walk
into one to take hold. A tilted ladder works (anything steeper than 30 degrees
from flat). The climb is `Player.updateClimbing` and shares the walk's collision
sweep, so walls and ledges still stop you. The third-person pose (hands
reaching by turns, legs stepping) is in `playerModel.ts`.

**Where the code is.**

- `shared/items/building.ts` — `PIECE_SPECS` (size, contact face, long axis,
  `grips`, `walkable`, `climbable`, density), `BuildField` (the pieces, ray casts,
  what is held up, save/restore), `PieceJoint` (reserved for fasteners).
- `shared/items/buildPlan.ts` — `aimAtSurface`, `PiecePlanner`.
- `shared/items/placementControl.ts` — the spin and tilt.
- `shared/sim/climb.ts`, `Player.climb` / `Player.rails` — rails and climbing.
- `shared/sim/rotation.ts` — quaternions and 3x3 turns; `sceneQuery.ts`
  `OrientedSolid` / `SceneSolidQuery.pieces` — pieces the player collides with.
- `client/physics/buildSystem.ts` — the Jolt bodies, meshes, anchoring and
  waking; `physicsWorld.ts` `spawnPiece`; `render/pieceMesh.ts` — real-size meshes.
- `main.ts`: `buildField` / `buildSystem` (before the save block), the aim and
  `placeHeld` in the placing block, the E pickup, `orientation` at the top of the frame.

**Next (not built yet):** duct tape and nails as fasteners (a `PieceJoint` makes a
loose piece part of a fixed structure, with a break strength; `sim/elastic.ts` is
the model for a tape that stretches before it tears), edge-to-edge snapping
(a piece aimed near another's end or edge goes flush beside it, so a ladder
extends a ladder), and a free/snap toggle for position.

### Inventory, crafting and containers

**I** opens the inventory screen (Esc or I closes it); it frees the mouse and
freezes the player. The inventory is an 8x4 grid (`INVENTORY_COLUMNS` /
`INVENTORY_ROWS` in `inventory.ts`): three backpack rows with the hotbar as
the bottom row. Click a slot to pick its stack up, click another to put it
down; a different item there is swapped, the same item is combined (up to
255), and right click cancels the move and puts the stack back. Closing the
screen puts the stack and the crafting boxes back in the inventory (or drops
what does not fit).

The pane above the grid is **crafting**, `_ + _ = _`: a box is added whenever
the last one is filled, for recipes with many ingredients. Put the materials in
the boxes and the product shows in the result box (its count in the corner).
Click the result to craft once: the material is used up and the product lands
on the mouse; click again to craft more (it stacks on the mouse, up to 255), or
press **ALL** under it to craft as many as the boxes pay for. Put the stack in a
slot, or just close the screen and it goes to the first free space (it is
dropped if there is none). The boxes must hold exactly a recipe's ingredients,
at least as many as it asks for; extra material just stays in its box.

Recipes are **learned**: one is known once every item it *takes* has been in
your inventory at least once (what it makes does not matter), and only known
recipes show up. What you have held is saved with the player. When the boxes
match several known recipes (a log is 4 sticks, 2 toobifers, 1 plywood or 4
wheels) the result shows the first, and a small `1/4` button beside it steps
through the rest; that is a stopgap for a proper list of everything a material
can make (see TODO). Recipes are the `RECIPES` table in `items/crafting.ts`:

| Takes | Makes |
|---|---|
| 1 log | 4 sticks, or 2 toobifers, or 1 plywood, or 4 wheels |
| 4 toobifers + 5 sticks | 1 ladder |
| 2 sticks + 1 plywood + 4 wheels | 1 skateboard |
| 1 mowden lightning | 1 metal |
| 2 metal | 1 spring |
| 1 toobifer + 1 xmas lights + 2 springs | 1 pair of spring shoes |
| 1 stick + 1 wheel + 3 xmas lights | 1 fishing rod |
| 10 leaves | 1 toilet paper |
| 12 toilet paper + 4 metal | 1 trampoline |

**Spring shoes** (`spring_shoes`) are worn while they are the selected hotbar
item: one shoe (`spring shoes.glb`, not resized) is snapped by the top face of
its sole onto the bottom of each foot of the character, and follows the leg;
the springs hang below the foot, so the model stands that much higher while
they are on (the collision box does not change). They work like a trampoline
does, energy in = energy out (`items/springShoes.ts`, called from the substep
loop in `main.ts`):

- walking, every step is a small leap; stopped, nothing happens;
- every landing rebounds at 0.9 of its landing speed, and a landing in the
  middle of a stride adds a little (up to a cap), so a run of bounds climbs;
  a landing timed with a jump (space held, or pressed just before) adds more,
  up to a higher cap;
- a jump from standing is 1.7 times a plain one;
- a drop from height comes back up nearly as high, past the caps, because that
  energy came from the fall; landing on a trampoline mat adds a quarter to the
  mat's own rebound.

The **spring** is a plain ingredient: held, and nothing else.

The hotbar's **empty slots act like slot 1, bare hands** (scoop, chup); only
slot 1 shows the icon. When the last of a stack is used up while a mouse button
is still down, nothing is scooped until the button is released.

**Containers** are the Present (`present_1.glb`) and the Gift (`present_2.glb`)
in Christmas, and the Candy Bucket in Halloween, all rare finds. Aim at one
within pick-up reach and press right mouse to open it: its grid appears beside
the inventory; click items between the two, or press **Take all** under its
grid to move everything that fits into your inventory (the rest stays in the
container; `takeAll` in `items/container.ts`). (I with one in reach does the same.)
E on an *empty* container picks it up as an item (`present_small`,
`present_big`, `candy_bucket` in the code), and left mouse places it again. An empty
present has a black top (a placeholder for the opening animation and interior
texture, see `render/containerLook.ts`); an empty candy bucket hides its
filling. Grid sizes are the `grid` rows in `OBJECT_SHEET`. Containers in the
world are stocked from their region's loot table (below), plus anything in the
container's own `loot` row in the generation sheet. Entries are single items.

- **Chupping a tree** takes three swings at about one height to cut through
  it. The cut face is capped, on the stump and on the piece, and drawn with
  `treestump.png`; every later cut of a piece is capped the same way. The piece above the cut falls as a Jolt rigid body built from the
  tree's own sliced mesh, onto the stump it came from and away from you.
  Stumps and standing trunks near a falling piece are static cylinders in
  Jolt, and trunks near the player are solid to walk into.
- **Chupping a felled piece** (two swings) cuts it in two at the swing, the
  same slice the tree got. Any piece 1.3m or shorter is not a body at all:
  it breaks into **logs** -- one per 0.12m^3 of wood, at most six -- and any
  foliage it was carrying puffs into leaves. So a tree comes apart into four
  or five logs. Numbers are at the top of
  [`logSystem.ts`](packages/client/src/physics/logSystem.ts).
- **Sticks** splash out of the bark on a chup that lands on a tree or a
  piece, flung towards your side: a quarter of what they were, so about one
  chup in three gives one (`STICK_SPLASH_AVERAGE` in `main.ts`).
- **Leaves** come from scooping foliage (left mouse on a canopy; 2 or 3 a
  scoop, half of what it was; the leaves mesh is drawn at 0.4 m across) and from pieces breaking down (2 a foliage
  cluster, was 4).

Dropped items are their own meshes (`log.glb`, `stick.glb`), hovering above
the ground, bobbing and slowly turning about the vertical so they are easy
to spot. Everything is a mesh now (the leaf is `leaves.glb`, a small bunch of
maple, oak and poplar leaves).
Nothing is collected by walking over it any more: aim at it and press **E**
(anything right at your feet also counts). A prompt under the crosshair
says what E would pick up.

**Equipping** is selecting the slot. The item shows in your hand in both
views -- the first-person arm
([`armViewmodel.ts`](packages/client/src/render/armViewmodel.ts)) and the
third-person character
([`playerModel.ts`](packages/client/src/render/playerModel.ts)) -- and so do
the actions:

- **Stick**: gripped in a fist near the plain end, the forked business end
  up and forward. Left mouse swings it like a sword -- the chop animation,
  and a chup on whatever it hits. Hold right mouse to charge a throw (up to
  1.2s, 9 to 24 m/s); the arm draws back and the stick swings round to point
  ahead, and release throws it fork first
  ([`thrownSticks.ts`](packages/client/src/physics/thrownSticks.ts)). It
  sticks into ground or trunks at the angle it hit (pick it back up with E),
  shoves a felled piece it hits, and bounces off props.
- **Log**: carried on the upturned palm in first person, and across the
  chest in both arms in third person. Both buttons charge while held (up to
  1.2s) and let go on release:
  - **Left mouse bowls it** like a bowling ball: set down just ahead of
    you, lying across your path, rolling (0.6 to 8 m/s). A tap barely moves
    it (about 10cm on the flat), a full charge sends it about 20m. Wind-up
    swings the arms back low; follow-through goes out along the ground.
  - **Right mouse lobs it** underhand, granny style: from waist height, up
    at 40 degrees (plus half your look pitch), tumbling (2.5 to 12 m/s, so
    from about a metre to about 17m). Wind-up is down between the knees;
    follow-through goes up and out.

  A thrown log is a Jolt cylinder with the log mesh on it, rolling and
  bouncing over the terrain and off stumps and felled pieces. When it comes
  to rest (or after 15s) it turns back into a log pickup where it stopped.
  Jolt has no rolling resistance, so `logSystem.ts` applies one
  (`ROLL_RESISTANCE`, a steady 1.6 m/s^2 while touching the ground): a slow
  roll stops properly, and a log stays put on a slope gentler than about
  15 degrees. Throw numbers are at the top of `main.ts`.
- **Snowball**: held in the fist. Snow comes from **snowbanks** (a drift
  scattered over the Christmas biome, 20% either way in size, a fixed number
  of hits' worth in each, **shrinking as the snow is taken until the last
  handful takes the whole drift with it**, and solid ground: walk up and over them, they use
  the drift mesh itself as a height field, see
  [`mound.ts`](packages/shared/src/sim/mound.ts)) and from **rolled snowballs**: scoop, chup, or
  swing a stick at either and a few snowballs pop out as pickups, one unit
  of snow each. Both buttons charge while held, as the log does:
  - **Left mouse rolls it** along the ground, with the log's bowl speeds.
    On snowy ground (the Christmas biome) it picks up snow as it goes and
    grows, faster the faster it rolls, and a hill makes a huge one quickly
    (up to 1.6m radius). It does not turn back into an item when it stops:
    it stays as a terrain feature, worth one snowball
    per unit of its radius, rounded up, and each hit shrinks it in proportion
    until it is gone. One with nobody within render distance for 5 minutes is
    forgotten. [`snowball.ts`](packages/shared/src/items/snowball.ts) has the
    numbers; a huge ball collides as a smaller one (see `PROXY_MAX_RADIUS`).
    Walk into one and you shove it: it rolls ahead of you at your speed,
    growing as it goes if the ground is snowy, and carries on rolling when
    you stop (jump to clear a small one). Rolled balls are solid to each other: a rolling one stops against a
    settled one, and two rolling ones shove each other, the lighter more.
  - **Right mouse puts it** overhand like a shot put (9 to 26 m/s): the arm
    cocks back and up as a spear throw does, and the ball flies fairly flat
    and bursts into a puff of snow on the ground, a wall or a trunk.
- **Rock** (`rock`, stacks to 255): held in the fist and used exactly as a
  snowball is: **left mouse rolls it** along the ground, **right mouse puts it**
  overhand (same charge, same speeds), minus the snow. It does not grow or burst:
  a put rock flies, lands, bounces a little and rolls to a stop, in the same
  field as the snowballs
  ([`snowball.ts`](packages/shared/src/items/snowball.ts) takes a `RollMaterial`,
  and [`rock.ts`](packages/shared/src/items/rock.ts) is the stone one). Rocks
  lie about the **Forest** (uncommon) and **Halloween** (rare), in a
  range of sizes. A rock in the world is not scenery. It is a body with weight
  (a standard one is about 25 kg, more by the cube of its size; the dev stats
  show the mass of the one you aim at):
  - It lies perfectly still until something moves it, and stays where it
    lands or is left; it is never forgotten. It is drawn on its flat side, and
    stays on a slope a snowball would roll down.
  - **E** picks it up (any rock in reach under the crosshair), and ropes tied
    to it let go.
  - Walk into one and you shove it, but it only gets a share of your speed
    (momentum is shared, by weight) and pushes back on you: a small rock goes,
    a big one hardly stirs. A scoop, chup or swung stick shoves it the same
    way. A rolling rock or snowball that hits a lying rock knocks it, by weight.
  - **Ropes**: tie xmas lights to one and it is dragged when the rope is
    pulled; its weight is the pull's resistance, so a rock takes a lot more
    pulling than a snowball.
- **Eggnog** (`eggnog`): a carton, used exactly as a rock is: **left mouse
  rolls it**, **right mouse puts it**, and **E** picks it back up. It rolls as a
  ball ([`rolledItems.ts`](packages/shared/src/items/rolledItems.ts) lists the
  rock and the carton; a third is a row there), weighs about a kilogram so it is
  shoved aside easily, and lies on its side when it stops. It hurts snowmen and
  houses for 1 a hit. Nothing else yet: it is not drinkable.
- **Coal** (`coal`): held in the fist, and that is all; no mouse button does
  anything with it. Every snowman drops **1 or 2** when its head comes off
  (`drops` in `OBJECT_SHEET`, `maxAmount`).
- **Metal** (`metal`, a crushed block of cans) and **candy** (`candy`, a
  chocolate bar, rocket pop and lollipop in a heap): held in the fist like coal,
  and that is all. Both are rare Christmas finds.
- **Mowden lightning** (`mountain_lightning`, a can) and **goo** (`goo`) are
  *vessels* ([`vessel.ts`](packages/shared/src/items/vessel.ts)): **hold left
  mouse to shake** the one in your hand (the arm jerks up and down, it rattles,
  and the longer you hold, up to 1.4 s, the more shaken it is; it settles over
  about twelve seconds after you let go), **hold right mouse to charge and
  release to throw** it. It flies on its own gravity and bursts if it meets
  something hard enough, measured as speed *into* the surface: a glancing hit
  does not count. A fresh can needs 15 m/s (a full-charge throw is 26); a fully
  shaken one bursts at 5 and sprays 2.4 times as much. A throw that is too soft
  to burst just lands, and is an item to pick up again. A burst sprays
  green hard-edged square chunks, like the crumbs of a broken house
  (`GOO_BURST` in `snow.ts`, the green of `gooMaterial.ts`).
  Goo is the same, except it is thrown at 4 to 11 m/s (hardly 12 m), splats at
  2.5 m/s (1.5 shaken), and leaves a big stain (radius 1.1 m, 1.8 shaken)
  on whatever it hit, flat on that surface, lasting 90 s (28 at a time). Goo
  has two meshes: `goo.glb`, the puddle, in a slot, a container or on the ground,
  and `gooball.glb` in the hand. The slime look is a new see-through material
  ([`gooMaterial.ts`](packages/client/src/render/gooMaterial.ts)). The tuning
  numbers are `VESSELS` in `vessel.ts`.
- **Xmas lights** (the basic rope; `xmas_lights`, stacks to 255): wound up
  in a coil as an item, held in the fist. Equipped, left mouse ties it; see
  [Xmas lights](#xmas-lights-rope-and-bulb-glow) below.
- **Leaf** (`leaf`): a bunch of leaves (`leaves.glb`) pinched in the fingers. The
  fabric of the game: ten of them make a roll of toilet paper.
- **Toilet paper** (`toilet_paper`): made from 10 leaves, and 12 of it with 4
  metal make a trampoline. Used exactly as a rock is (**left mouse rolls it**,
  **right mouse puts it**, **E** picks it up; a row in
  [`rolledItems.ts`](packages/shared/src/items/rolledItems.ts), about a tenth of
  a kilogram, hops a little), but it does no damage. It is light: it leaves the
  hand at half a rock's speed (`speedScale` in `rolledItems.ts`) and the ground
  slows it hard, so a good bowl goes about two metres and a good throw nine.
  In the first-person hand it is seated against the palm (`PAPER_POINT` in
  `armViewmodel.ts`); bowling turns the wrist a quarter so it runs like a wheel,
  and a throw is drawn back and swung out to the right, not up over the shoulder. The mesh (`tp.glb`)
  has three named parts, found by name
  ([`paperFlap.ts`](packages/client/src/render/paperFlap.ts)): the **roll**
  (`roll`), the **flap** (`flap`: the loose
  end, a strip of squares joined to the roll along its nearest edge) and the
  **hand mark** (`hand goes here`). In a slot, on the ground and in the hotbar
  the flap stays as modelled. In the hand it is a hanging strip that swings and
  flaps with the arm (a short chain of points under gravity, kept out of the roll;
  tuning constants at the top of `paperFlap.ts`). Rolled or thrown, the flap is
  copied behind the roll as a **trail** of ribbon, one cell per flap length with
  its texture ([`paperTrail.ts`](packages/client/src/render/paperTrail.ts)): on
  the ground it is laid down following the surface under each corner, in the air
  it is left where the roll was and floats down, settling on whatever is under
  it (ground, log, snowbank, piece). It is not a cloth simulation. Trails fade
  90 s after the roll leaves them; at most 40 ribbon meshes of 120 cells exist at
  once, and the oldest is recycled. The rolled roll turns like a wheel and stands
  on its end when it stops.
- **Empty hand**: a chup is a karate chop; the scoop dips both hands.

#### Held items, multiplayer, and adding a new one

Everything a player's hands are doing is one small value, the **avatar
pose** ([`avatarPose.ts`](packages/shared/src/items/avatarPose.ts)): the
held item, the action under way (idle, scoop, chup, and the three throw
wind-ups: spear charge, bowl, lob, put), the throw charge, a throw counter and
which kind of throw the last one was. It packs into four bytes (`packAvatarPose`),
which is what multiplayer will send each tick for each player. The local
player builds it from input in `main.ts`; both views draw from it and
nothing else, so a remote player's character -- a `PlayerModel` fed a
received pose and an `AvatarBody` snapshot -- will hold and swing exactly
what they are.

- Looping actions (scoop, chup) are just "on"; each viewer runs the swing
  cycle itself at the shared `CHUP_CYCLE_SECONDS` / `SCOOP_CYCLE_SECONDS`,
  which also set the gameplay tick rates, so the hit lands on the swing.
- A throw is the counter going up by one, so a viewer that drops a packet
  still plays the follow-through once (`ThrowWatcher`).
- What an action looks like comes from the item's **hold style**, not the
  item: `Blade` (stick: sword grip, slash, spear charge and throw),
  `Carry` (log: two-handed, across the chest, bowled or lobbed), `Pinch`
  (leaf), `Ball` (snowball, xmas lights: in the fist, rolled or put), `Empty`.

The third-person arms are bent per vertex like the walk (one-bone CPU
skinning, now about any axis). Poses are written as "where the arm points
from the shoulder" in body space (X forward, Y up, Z right) at the top of
`playerModel.ts` (`HOLD_AIM`, `SLASH_RAISED`, `CHARGE_AIM`, ...). The
character's right arm holds things, and its hand is the grip point; the arm
that is "right" is measured on load, since the file's part names are
mirrored once the body is turned round.

To add a held item: give it a hold style in `avatarPose.ts`, and a mesh
builder in [`heldItems.ts`](packages/client/src/render/heldItems.ts), built
in that style's frame (Blade: shaft along +Z from the grip; Carry: long
axis along +X, centred; Pinch: at the origin). Both views pick it up from
there. A new kind of hold or action needs a pose in both
`armViewmodel.ts` and `playerModel.ts`.

### Xmas lights: rope and bulb glow

The first rope. A string of lights (`xmas_lights`, mesh `assets/meshes/xmaslights.glb`)
is the basic cordage for tying things together out in the world for physics
fun, the way the gmod tool gun does; the later elastic rope and wiring for
power will be variants of it.

**Using it.** Equip it (under `DEBUG`, which is on by default, you start with
10 alongside the trampoline and skateboard), then **left mouse** ties the
first end to whatever the crosshair is on, and **left mouse again** ties the
other. One string is used up. Between the clicks the string is a real rope
from the first tie to your hand: it hangs and drags on the ground, and when
you walk to the end of it (5 m a string) it stretches and pulls. Tied to a
rock or a rolled snowball it hauls that along behind you (a heavy one slows
you down); tied to something that cannot move (the ground, a tree, a
snowman) it holds you back, giving about a third again its length before it
goes hard like a wall (`PlayerRopeBody` in `items/rope.ts`). If you are flung
or teleported so far that it would stretch to 1.7 times its length (a respawn),
it lets go. You can only tie the second end to a surface within the string's
reach, not to the air. A string reaches up to 5 m between its ends, with no
minimum (tied end to end it lies in a heap). A placed string is cut a hair
shorter than the gap (`slack` in `RopeSpec`, -1%), so it is stretched like
elastic and hangs with only a little sag. There is no length readout: the
rope shows how far it goes.

**Running strings on.** With more strings in the stack, **right mouse**
(after the first end is tied) adds another string to the one being placed:
reach goes up by 5 m each time, up to 6 strings (30 m), as far as the stack
goes. This ties nothing and the rope in your hand keeps its shape; it is one longer rope, with 9 more segments per
string, that is tied at the end with left mouse and uses up all its strings
([`ropeSpecFor`](packages/shared/src/items/rope.ts)). **E**, with one end tied,
cancels the placement (nothing is spent until both ends are tied; strings
already tied stay). The bottom-right legend shows which of these apply.
**E on a tied string** picks it up again (4 m reach, whatever you are
holding), giving back every string in it, as with any item. Things it can be tied to: the ground, a tree, a rolled snowball, a
felled log piece. Tying to other players is stubbed.

**What it is.** Three red-green-blue sets of bulb and wire: nine segments,
each a piece of wire with its bulb, straight and bending at the joins. Until
it is tied it is drawn coiled up flat, bulbs out round the rim, in all four
places an item shows up: on the ground, in the hotbar, in the first-person
fist and in the third-person hand (`HoldStyle.Ball`).

**How it moves.** Simulated as a chain
([`rope.ts`](packages/shared/src/items/rope.ts), position-based dynamics with
compliance, at the fixed 1/120 s step): it only resists being stretched,
never squashed, so it sags, lies on the ground and over mounds, and wraps
trunks. Past its length it is a stiff spring with a force cap, pulling on a
rolled snowball (which wakes up and gets dragged) or a felled log piece (which
turns where it is tied; [`ropeBodies.ts`](packages/client/src/physics/ropeBodies.ts)).
Ties to ground, trees and mounds are rigid. Ropes freeze when far from the
player, at most 64 exist, and one with no end left (its snowball used up) is
gone after 20 s. Everything about one kind of rope is a `RopeSpec`
(`XMAS_LIGHTS`): segment count and lengths, slack, stiffness, force cap,
mass. A looser, springier rope is a new spec, not new code.

**Walking into it.** A tied string is elastic and the player is solid to it:
walk (or roll, or skate) into one and it stretches round you, slows and stops
you, and when you ease off or step back it snaps in and throws you back, the
harder the further it was stretched. It gives up to its "max elastic"
(`maxStrain`, 40% longer for the xmas lights), past which it goes hard like a
wall. A string lying lower than 30 cm is stepped over. Walking steering cannot
cancel the throw in a step (the player keeps a shoved part of their velocity
apart, `Player.applyImpulse`, that wears off by itself: quickly on the ground,
hardly at all in the air), but you can lean on a stretched string with about
4.5 m/s of effort; a run or a skateboard will stretch it further. Past roughly
8 m/s (a ragball at speed) the string cannot hold you and you go through it.

None of that is rope code. The spring law, the "max elastic", and how a moving
thing is pushed out of the way and pushed back on live in
[`elastic.ts`](packages/shared/src/sim/elastic.ts), and are meant for every
elastic thing to come: `ElasticMaterial` (stiffness, max strain, force cap;
a `RopeSpec` is one), `elasticForce(material, restLength, stretch)`, and
`ElasticCollider`, which anything that can be bumped implements (bounds, a
push-out shape, velocity, a push), with `boxPushOut` / `spherePushOut` to build
one. [`PlayerBody`](packages/shared/src/sim/playerBody.ts) is the player's. A
rope is given the list of colliders each step; it holds its nodes out of every
one, and pushes each back with its own stretch force, along the bend of the
string round it. A bungee, a rubber band or a bouncy mat is a material, a
shape and the same two calls.

**How it is drawn.** [`ropeView.ts`](packages/client/src/render/ropeView.ts)
builds each segment from the GLB's pieces: the wire stretched to the
segment's length, the bulb kept its own size, and rolled about the wire so
the bulbs hang down (they sit 120 degrees apart in the file).

**The glow.** The N64 way, no bloom, no real lights. The bulb glass is drawn
unlit in a bright colour with a soft additive halo sprite round it. On top of
that, [`bulbLights.ts`](packages/client/src/render/bulbLights.ts) lets the
bulbs light their surroundings: each frame the 32 bulbs nearest the eye
(within 45 m) go into one pool of shader uniforms, and the ground shader
and every Lambert material (trees, props, the player model, the arm; wrapped
with `litByBulbs()`) add a soft coloured pool of light on top of their own
lighting, red, green or blue, 1.8 m across with a smooth falloff that wraps
round the far side like vertex lighting did. It is additive, so it shows at
night and barely in daylight. Bloom and colour bleed are not done. Tuning knobs: `BULB_LIGHT_RADIUS`,
`BULB_LIGHT_INTENSITY`, `MAX_BULB_LIGHTS` in `bulbLights.ts`; `BULB_COLORS`,
`LIGHT_COLORS`, `HALO_SIZE`, `HALO_STRENGTH` in `ropeView.ts`.

**On Christmas trees.** About one Christmas conifer in four is strung with
one to three strings (`tree.lights`). Which trees, and how many, is decided
from the tree's id alone (`treeLightCount` in
[`trees.ts`](packages/shared/src/worldgen/trees.ts)), so it is the same every
time the tree streams back in. [`treeLights.ts`](packages/client/src/render/treeLights.ts)
lays each string as a short swag spiralling down round the canopy, nestled
just inside the outline of the conifer's overlapping foliage tiers (a skirt
each, widest at the bottom, over a conical trunk) so it hugs the tree rather
than floating off it (`HUG`, `STRING_LENGTH`, `LOW`/`HIGH` to tune), and its bulbs glow and light the snow like a
tied string's. **The first chup that lands on the trunk, or scoop (left mouse, unarmed) anywhere on the tree,** knocks every string
off: one `xmas_lights` pickup each, flung towards the swinger like the
sticks, and the tree remembers (`World.chopTree` returns `lightsDropped`;
the tree is not lit again when its tile reloads, and a tree that streams in
already cut has none). Pick them up with E like any item.

### Fishing rod

`fishing_rod` (mesh `assets/meshes/fishinrod.glb`). Craft it from 1 stick + 1
wheel + 3 xmas lights. Equipped, **left mouse casts: hold to charge, let go to
throw** (the longer the hold, the farther it lands and the higher it arcs, and a
dashed line shows the path and a ring where it will come down); **right mouse
reels in** (held; let go and the hook stays where it is; right mouse while
charging cancels the cast). The line is a string of xmas lights drawn at 0.6
of their thickness, from the rod's tip to a red-and-white bobber.

Until the physics engine is done the rod only does one job: the hook snags a
dropped item (a pickup) it flies onto or is reeled over, drags it along the
ground, and an item reeled all the way in goes into the inventory, the same as
pressing E on it (if the inventory is full it is let go at your feet). The
hook flies and slides over the terrain only: trees, props, felled logs, rolled
balls and water do not stop or catch it yet, and the line is a drawn curve (it
hangs by how slack it is, and is kept off the ground), not a simulated rope.
Walking away from a hook that is out drags it after you at the line's limit.
Putting the rod away winds the line up and lets go of anything on the hook.

**Settings** are the `FISHING` object in `packages/shared/src/items/fishing.ts`
(a `FishingSettings`; change a number there, nothing else needs touching):

| Setting | Default | What it does |
|---|---|---|
| `maxLineLength` | 15 m | **The farthest a cast can land and the farthest the hook may ever be from the rod.** Set to the reach of three strings of xmas lights (`ropeMaxReach(ropeSpecFor(XMAS_LIGHTS, 3))`, 3 x 9 segments x 5/9 m), so it follows if the lights change. A full cast lands at 0.97 of it. |
| `chargeSeconds` | 1.1 | Hold time for a full cast |
| `minCastFraction` | 0.15 | How far a tap goes, as a fraction of `maxLineLength` |
| `arcLow`, `arcHigh` | 0.1, 0.55 rad | Launch angle added to where you are looking, for a tap and for a full charge (look higher to lob higher; distance comes from the charge alone) |
| `minLaunchAngle`, `maxLaunchAngle` | 0.12, 1.2 rad | Clamp on the launch angle |
| `gravity` | 9.8 | For the hook in flight |
| `reelSpeed` | 6.5 m/s | How fast the hook comes in |
| `hookRadius` | 0.55 m | How near an item the hook snags it |
| `catchRadius` | 1.4 m | Reeled this close to you, the catch is taken |
| `hookRestHeight` | 0.12 m | How high the hook rides above the ground |
| `lineScale` | 0.6 | Line thickness against the xmas lights' |
| `previewWhenIdle` | false | Also show the aim line (at the shortest cast) while the rod is held but not charging |

The rest of the look is in `client/src/render/itemAssets.ts`: `HELD_ROD_LENGTH`
(2.2 m in the hand) and `ROD_ITEM_SIZE` (on the ground and in a slot). The file's
`hand_attachment_point` is where the hand closes (the rod is held in the Blade
style, like the stick; a cast reuses the spear throw's wind-up and lunge, but
the rod stays in the hand; the charge draws it back over the shoulder towards you, the release whips it forward). The held rod is rolled about its length every frame so the reel hangs underneath at rest (`HeldItemSlot.settleRod`; the roll is held during a cast so the rod swings as one piece). **`line_attachment_point` in the file is still at
the model's origin (the handle's butt)**, so the game falls back to the top of
the rod and logs a console warning; move that empty to the tip in the .glb and
it is used as is. The sim is `items/fishing.ts` (`Fishing`, tested in
`fishing.test.ts`); the line, bobber and aim dashes are `render/fishingView.ts`;
`main.ts` feeds it mouse input and the rod tip's world position (read off the
held mesh by name, `ROD_TIP_NAME`, in the first-person arm or the third-person
model).

### The ground

There are no voxels and no digging (voxels were an earlier version of the game and
are not coming back). The ground is a smooth low-poly **heightfield mesh**: a
lattice with a vertex every 0.8 m (`GROUND_STEP` in
[`groundField.ts`](packages/shared/src/worldgen/groundField.ts)), cut into 3.2 m
tiles that stream in and out around the player (`?radius=N` tiles). The world is one
layer of tiles high. Hills, cliffs and bluffs are the same shape as before, only
smooth; a cliff is a steep ramp over about one cell. The unarmed scoop no longer
touches bare ground: it acts on trees, snowbanks and snowballs only.

Collision still thinks in 10 cm cells: the solid test samples the smooth mesh at
cell centres. Trees, props and building pieces stand on the mesh height. Open
graves have real pits: a tile that contains one is meshed on a finer 0.2 m lattice
with the ground lowered to the grave box's floor
([`gravePits.ts`](packages/shared/src/worldgen/gravePits.ts)).

**Textures** (`assets/textures`, 64x64, blended per vertex between regions): the
Plain region uses `grass2_TWP.png` with `dirt1_twp.png` patches (slow noise, and
steep slopes, go dirt); Halloween uses the same two drained of colour and darkened;
Christmas is `snow_64x64.png` alone. One texture repeat covers
`GROUND.textureTileMeters` (6.4 m). That, the dirt patch size and threshold, the
slope thresholds and Halloween's desaturation and darkening are all in `GROUND` in
[`generationSheet.ts`](packages/shared/src/worldgen/generationSheet.ts); the shape
of the land is `TERRAIN` there.

Explosions and large impacts may one day carve craters out of the ground, but not
as voxels: the seam is documented in `groundField.ts` (an additive height term).
That is a possible future feature, not a plan.

### Graphics: the N64 look

The 3D scene is drawn at a low internal resolution (default 240 lines, so 320x240
at 4:3) into a render target and scaled up to the window with nearest sampling,
with a light horizontal smear and a 5-bit-per-channel ordered dither
([`n64Pass.ts`](packages/client/src/render/n64Pass.ts),
[`n64Dither.ts`](packages/client/src/render/n64Dither.ts)). The HUD, the 3D
hotbar and the inventory items are drawn at full resolution on top.

- `?res=480` (hi-res; `240` or `480`) and `?aspect=4:3|16:9|window` set the picture
  and are remembered in `localStorage`. A 4:3 picture in a wider window gets black
  bars. They live in [`renderSettings.ts`](packages/client/src/render/renderSettings.ts);
  a future in-game settings menu will call the same store.
- Textures are Nearest with no mipmaps (`nearestify` in `render/n64Texture.ts`); the
  ground uses the N64's 3-point filter (`n64Sample`).
- Fog is short, starting at about 25% of its far distance (presets in
  [`atmosphere.ts`](packages/client/src/render/atmosphere.ts)).
- No PS1-style vertex wobble or affine texture warp: the N64 did not have them.
- Goo has no sun specular or reflection; it is Lambert and looks unlit.

### The generation sheet

[`generationSheet.ts`](packages/shared/src/worldgen/generationSheet.ts) is the
one file to tune the world from. It has a section for each region:

- what spawns there, each as `common`, `uncommon` or `rare`
  (`BIOME_SHEET`);
- how hilly, cliffy or flat the ground is (`TERRAIN`), and what it looks like:
  texture size, dirt patches, slope thresholds, Halloween's drained colour
  (`GROUND`; see [The ground](#the-ground));
- per-object rows (`OBJECT_SHEET`): what swinging at a snowman gets you, what
  a container holds, how flat the ground must be under it;
- `lootTable` per region: what turns up in its containers and in its
  gingerbread houses and huts. Christmas has one (xmas lights, mowden lightning,
  eggnog, snowball, log, stick, coal, metal, candy, each with a rarity); the other regions
  (Forest included) have none yet. Names with no item behind them yet are skipped.

Adding a mesh: put the `.glb` in `assets/meshes`, add its metrics to
[`props.ts`](packages/shared/src/worldgen/props.ts) and its materials' looks to
`propAssets.ts`, then list it under a region. (A rock is the exception:
`dynamic: true` in its metrics means the world only places it, handing it to the
game as a physical body, `onRockPlaced`, once per rock; the game owns it after.)

### Regions

| Region | Ground | Spawns |
| --- | --- | --- |
| Christmas | Flat, with gentle rolling hills. | Conifers, bushes, snowmen (two sizes; sticks), presents (two sizes; containers; rare), gingerbread houses (very rare). |
| Halloween | Flat sections, and cliffs that jut out of them. | Dead trees, a few autumn-coloured broadleaf trees, tombstones (two kinds), graves, candy buckets (container; rare), the odd rock (rare). |
| **Forest** | Flat, gently hilly, and big cartoony multi-tiered bluffs. | Broadleaf trees, bushes, rocks (uncommon), huts (very rare). |

**The third region is the Forest biome.** It is the ground between the two
holiday regions. In the code it is still `Biome.Plain` (and `plain` in
`TERRAIN` and the biome weights); the sheet labels it "forest". Coming for it:
chests, a forest loot table, a bigger tree, shrubs and thin grass, vines off
trees.

Height is the game's progression: the player cannot climb a cliff or a bluff
face, so getting up to what is on top means building something to get there.

Graves are cut into the ground, and a covered one (most of them) is hidden
under topsoil. Removing the topsoil needs a tool the player does not have yet.

### Snowmen

Snowmen are solid (a squat cylinder per ball, so you cannot walk through one,
and rolling snow and rocks bump off) and they come apart. Each ball (the small
one has a body and a head, the big one a body, a middle and a head) has hit
points, `PROP_SECTIONS` in [`props.ts`](packages/shared/src/worldgen/props.ts);
a blow takes damage off the ball at the height it landed
([`propDamage.ts`](packages/shared/src/sim/propDamage.ts), `PROP_DAMAGE`: chup
1, scoop 1, thrown stick 1, snowball 0.5, rock 3). A ball that has taken all it
can **flies off and bursts into snow**, taking everything above it with it, and
leaves some snowballs to collect; the bottom ball going is the whole snowman
going, and it stays gone. Every hit, by anything, shakes loose a spray of the
same flakes the Christmas weather is made of (`SnowFlakeBurst` in
[`snow.ts`](packages/client/src/render/snow.ts)).

Only the big snowman has sticks (two) and the small one has none. Each releases
1 or 2 **coal** when its head comes off. Felled logs do not collide with snowmen yet (their bodies live in
the rigid-body world, not in the cylinders above).

### Gingerbread houses

A rare landmark in the Christmas region (`gbreadhouse_1.glb`, a 2.4 m cabin with
a chimney). They spawn at the `structure` rate, one cell in about 1,100 before the
checks that a house be on level ground (`maxSlope`) and clear of whatever the
cells around it hold, which leaves about **one per 20,000 m²**: Christmas regions
run from a few hundred m² to 85,000 (median 8,000), so a small one has none, a
typical one none or one, and a big one two or three. The bigger the region, the
likelier it has a house.

A house is solid (a box, so you cannot walk in) and takes **12 chups** (rock 3,
thrown stick 1, snowball 0.5; `breakable.hits` in
[`props.ts`](packages/shared/src/worldgen/props.ts)) from any side. Each hit
knocks off crumbs; the last one **explodes it**: the mesh comes apart into its
triangles, which fly off tumbling and vanish after a second or so
([`shatter.ts`](packages/client/src/render/shatter.ts)), and the house is gone
for good.

Every house has **one item** inside, drawn from the region's loot table (common
three times as likely as uncommon, uncommon three times rare), which hops out of
the wreck when it blows. One house in five also has a **present or gift** standing
in its middle, stocked from the same table like every other present; it is there
from the start, behind the walls. The item and container odds are the `interior`
row in `OBJECT_SHEET`.

### Huts

A rare landmark in the Forest region (`hut.glb`: a round hut under a conical
thatch roof, ringed by a thin wall of grass). It spawns exactly like a
gingerbread house (`structure` rate, level ground, clear of its neighbours; the
Forest is most of the world, so there are many more of them than houses), and is
solid the same way: a box just inside the round of the walls, you cannot walk in.
The hut is 1.3x authored size (walls 1.85 m, roof 4.3 m across): the `scale` in
[`props.ts`](packages/shared/src/worldgen/props.ts) is the dial.

It takes **15 chups** (rock 3, thrown stick 1, snowball 0.5) from any side, with
a puff of wood, thatch and grass crumbs per hit; the last one explodes the whole
hut into its triangles, like a house. The grass ring is a separate prop (`hut_grass`, an `OBJECT_SHEET` companion placed with every hut) and stays standing.

**Weak to fire (stub).** `breakable.fireMultiplier` (10) is wired through
`breakableDamage` in [`propDamage.ts`](packages/shared/src/sim/propDamage.ts)
for a `fire` source, so a burning hut goes in about 1.5 s. Nothing can set
anything alight yet, so nothing deals it.

**Contents (stub).** The `interior` row for `hut` in `OBJECT_SHEET` has
`contents: "floor"`: a chest standing on the floor in the middle, and loose items
on the ground there. The Forest has no loot table and no chest yet, so a hut is
empty today. Today loose items still come out when the hut breaks, because
nothing places a pickup at world generation.

The grass ring is a cut-out: the material is alpha-tested (not blended) from the
texture's alpha, so the gaps are fully empty and need no sorting. The file's own
material is a blended one; `propAssets.ts` replaces it (`NODE_LOOKS`,
`grass_surrounding`). Thin grass for the rest of the forest can reuse that look.

### Saving

Close the tab and come back: you are where you were, with what you had, and the
world is as you left it. Two saves, because they have different owners:

- **Player save** — position, facing, hotbar slot in hand, the whole inventory.
  Small; written to `localStorage` (`fgp.save.player`), which is the write that
  reliably lands while a tab is closing. (Name, face and colours are already kept
  by character create, `fgp.appearance`.)
- **World save** — only what players *changed*: the world itself is generated from
  the seed, so a save is the difference. Trees felled or stripped of leaves and lights; props picked up,
  placed, damaged or broken (snowmen, gingerbread houses, snowbanks); what is in
  each container (an emptied one stays empty); placed trampolines; placed building
  pieces (where each came to rest, and whether it is fixed); items lying on the
  ground (the first 500). Written to IndexedDB, which has room for it beyond
  `localStorage`'s limit. The ground itself is never saved (it cannot be changed). Old
  saves that still have a list of dug holes load fine; that field is ignored.

The same machinery fixes something that used to be lost *within* a session: a felled
tree or a picked-up prop is now kept when its tile streams out and back in.

**When it writes.** Every 10 s the player; the world only if it changed (a
`World.editRevision` counter, plus container/trampoline/pickup counts), and at least
once a minute regardless. And on `pagehide` / the tab going hidden. The HUD's `SAVE`
line shows the last write, or `FAILED` (private window, full disk) which it retries.

A restored position is clamped to `WORLD_CEILING_METERS` (16 m): the world is one
layer of ground tiles with no vertical stacking.

**Where the code is.**

- `shared/src/save/snapshot.ts` — the save types and `sanitizePlayerSave` /
  `sanitizeWorldSave`. Everything read from storage goes through these: unknown item
  names are dropped (items are saved by *name*, so reordering `ItemType` is safe),
  numbers are range-checked, a save from a newer game or another seed is refused. A
  corrupt save loses data; it cannot crash the game. `SAVE_VERSION` is the migration
  hook: bump it and convert old shapes in the sanitizer.
- `shared/src/save/gameSave.ts` — `capturePlayer` / `applyPlayer`, `captureWorld` /
  `applyWorld`, `worldRevision`. No DOM, no storage: the server calls the same.
  `World.exportEdits` / `importEdits` hold the world's part (tree and prop edits); `ContainerField.exportAll`
  / `restore` the containers.
- `shared/src/save/saveStore.ts` — the `SaveStore` interface (load/save a player and a
  world) and `MemorySaveStore` for tests. Loads never throw.
- `client/src/save/` — `browserSaveStore.ts` (localStorage + IndexedDB),
  `saveManager.ts` (timer and page-hide), `identity.ts` (player token, below).
- Hook points in `main.ts`: the load/apply block just before the debug kit, and
  `saveManager.update` in the frame loop.

**Adding something that should persist.** If it lives in `World` already (a new prop
state), add its map to `exportEdits`/`importEdits` and the type in `snapshot.ts`, bump
`revision` where it changes, and sanitize it. If it is a new field on the client (like
containers or trampolines), add it to `WorldSave`, `captureWorld`, `applyWorld` and
`worldRevision`. Always with a round-trip case in `save/save.test.ts`.

**What is not saved** (yet): tied strings of xmas lights, felled logs and other
Jolt bodies, rolled snowballs, moved rocks, anything in flight, the explored-area
map, skateboard state mid-trick. Things that are regenerated (the ground, trees,
untouched props) are not saved because they do not need to be.

**Multiplayer, next.** The plan this is shaped for:

- *Identity* is a random 128-bit token the browser makes on first visit and keeps in
  `localStorage` (`client/src/save/identity.ts`; not an IP, which is shared and
  changes, and not a cookie). The server stores only a hash of it, and only ever
  receives it over `wss://`, never in a URL. It is not used by singleplayer. Clearing
  site data makes a new player; an export code / account is the planned answer.
- *Same formats, different store.* The server implements `SaveStore` per connection
  (a file or SQLite) and runs `captureWorld`/`applyWorld` on the one shared world, so
  everyone joins into the same built-up map. The client then holds no save:
  the server owns inventories and the world, and checks everything a client sends
  (the sanitizers are the first line of that).
- Singleplayer stays as it is: the browser is both player and server.

### Known gaps

- Saving: see "What is not saved" under [Saving](#saving).
- Building: no fasteners yet (nothing joins a loose piece to a fixed one), no
  snapping of position to another piece's edge or end, and no
  sound for a piece hitting something. A piece that is being shoved by the player
  does not move: pieces are solid only once at rest, and the player does not push
  a Jolt body. A ladder cannot be climbed down from the top (you take hold from
  below, facing it), and the piece check treats unloaded tiles as air, so it waits
  for the world to finish loading. A piece falls when its support is chopped or
  picked up only at the next check (up to a second).
- Rocks: they are shoved by walkers, swings and other rolling balls, but not
  yet by thrown sticks, thrown logs (Jolt bodies), a flying snowball or a
  trampoline; they are spheres, so one never tips or rests on a corner; and
  nothing breaks them. They are not on the map.
- Props are not solid to the player, except snowmen, gingerbread houses, huts (and
  snowbanks, which are stood on); for the rest only the aiming raycast sees them.
- Gingerbread houses and huts are never walked into: they are a solid box until they
  explode, and a flying snowball or thrown log can pass through the gaps in it.
  The container inside cannot be reached before then.
- Graves: an open one has a pit (a finer 0.2 m mesh with the ground lowered to the box floor), but a covered one is left as solid
  ground under its topsoil (a hole there would be a trapdoor on the mound).
  The pit is cut when the topsoil comes off, which does not exist yet.
- Prop sizes and which way a mesh faces are first guesses (see the `scale`
  and `up` fields in `props.ts`).
- The first-person arm (`render/armViewmodel.ts`) is a single right arm with
  fixed lighting, not tied to the biome. Which face of the palm is the inside is
  unrecorded in the mesh: if the fingers curl backwards on the scoop, flip
  `PALM_SIGN`.
- Xmas lights: no tying to other players (the held end is the local player's
  hand), a string tied to a prop (snowman, house) holds you but does not move
  it, a
  tied string's anchor on a chopped tree stays in the air, no wiring for power
  yet, and no looser elastic variant yet (the elastic law and colliders are
  general, but only players bump a string: snowballs, logs, thrown things do
  not yet). Each segment is its own mesh (no
  instancing), so a forest of lit trees costs draw calls. Coils on the ground
  or in a hand glow but light nothing, snowball, log and skateboard meshes
  do not take the bulb light, and the glow does not twinkle or follow
  day/night. They are not yet placed as loot in the Christmas region
  (`generationSheet.ts`), only strung on trees.
- The ground: collision samples the smooth mesh in 10 cm cells, so a slope
  feels very slightly stepped underfoot. The N64 3-point texture filter is only
  on the ground; other materials use plain nearest sampling. Cliffs are steep
  ramps over about one 0.8 m cell, not true vertical walls.
- Debris particles are not in yet.
- Face textures exist but character create's face option does nothing.
- The walking collider is an AABB, not a swept capsule.
- A felled piece collides as a trunk-width capsule, so its canopy and the
  dead tree's branches are walked through. A piece is only walkable once it
  has settled; a moving one passes through the player.
- A stick stuck in a tree stays floating where it was if the tree is felled.
- The held-item grips (`STICK_GRIP`, `LOG_REST`, `PINCH_POINT` in
  `armViewmodel.ts`; the aim and grip constants in `playerModel.ts`) were
  placed from the meshes' measurements, not by eye; if the stick floats
  beside the fist, those are the numbers to move. The third-person poses
  were checked numerically (the grip sits on the deformed hand) but not
  looked at.
- The fat guy's arms are short: in third person a held log is drawn 1.5x
  so it reaches both hands, and the slash cannot cross far in front of the
  body.
- No networking yet: the avatar pose and `AvatarBody` are the hooks for it.
- A thrown or swung stick has nothing to hurt yet: there are no creatures.
- There is no drop action (items only land on the ground when the inventory
  is too full to take back a stack), no split-stack or shift-click, and the
  crafting list UI is a stub (the `1/4` cycle button).
- The default load radius is unmeasured on real hardware; check FPS before
  trusting it.

## Tests

`tools/golden/golden.json` holds reference data some of the shared tests
assert against (hashes, terrain, player movement). If one fails, the code is
wrong until proven otherwise — don't regenerate the file to make it pass.
The C++ build that recorded it has been removed from the tree; it lives in git
history before commit `6c60e4f`.

Rope, inventory stacking, the bulb-light picker and the tree-light rolls have
tests next to the code (`rope.test.ts`, `inventory.test.ts`, `treeLights.test.ts`
in `shared`; `ropeView.test.ts`, `bulbLights.test.ts`, `treeLights.test.ts` in
`client`). The shader side of the glow has no test; check it by eye on both
backends (`?gl` forces WebGL2).

Items now stack to 255 per slot (`MAX_STACK` in `inventory.ts`); adding more
than fits spills into new slots, and an add that cannot fit all of it is
refused whole.
