# fat_guy_physics

A multiplayer physics sandbox that runs in the browser — no download. See
[DESIGN.md](DESIGN.md) for the design.

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

Click to capture the mouse. WASD walk, Space jump, left mouse scoops, right
mouse **chups** (not "chops" -- chup is the game's word for it), E picks up
the item under the crosshair (hold it to hoover up a pile), R toggles
Ragball, V first/third person, `-`/`=` FOV, 1-8 hotbar, I inventory.

With a stick equipped: left mouse swings it like a sword (a swing is a chup,
so it fells trees too), hold right mouse to charge a spear throw and release
to throw. With xmas lights equipped: left mouse ties the first end, then the
other; right mouse runs another string on to reach further; E cancels.

### On-screen UI

Only the hotbar and what is relevant right now are shown:

- **Bottom right**, a keycap per button with its action under it, for
  whatever is in the hand (bare hands: LMB scoop, RMB chup; stick, log,
  snowball, trampoline, skateboard and xmas lights each have their own, and
  "hold" marks the ones that charge). The table is `controlHintsFor` in
  [`controlHints.ts`](packages/client/src/ui/controlHints.ts): a new item with
  a button action adds a case there.
- **Tab** toggles the debug readout (top left: FPS, position, chunk counts and
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
- `?radius=N` — override the chunk load radius (default 12 chunks, about 38 m).

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

Done: chunked terrain streamed through a worker pool, player controller and
collision, Jolt rigid bodies, trees you can fell and chup down into logs,
sticks and leaves, item pickups with E, a held stick you can swing or
throw, held items and their actions on the third-person character as well
as in first person, items and hotbar, player
rig and character create, biome field with ground colour, sky, light and
snow, per-region terrain height (rolling hills, cliffs, tiered bluffs), and
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
  eggnog do anything, and none is an ingredient yet (crafting has no recipes).
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

The trampoline and the containers are placed with **left mouse**. While one is
held, a see-through copy of it stands where it would go: **green** if it can be
put there, **red** if not (solid ground or a wall would be inside it, the
ground drops away too far under it, a mat, prop or tree is in the way, or you
are standing where it would go). A red click only plays the error sound. The
hand is shown empty in first person while you hold one (the ghost says where it
goes); third person, and so other players, still see it carried.

The rules are in `shared/items/placement.ts` (`PLACEMENTS` has one row per
placeable: footprint, height, how far the ground may fall away, whether it
faces you, whether to hide it in the first-person hand), the ghost in
`client/render/placementPreview.ts`. To make a new item placeable (logs,
plywood, 2x4s) add a row, a ghost builder, and a case in `placeHeld` in
`main.ts`; the aiming, the green/red test and the preview follow.

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
the last one is filled, for recipes with many ingredients. **Stub:** there are
no recipes, so the result box never fills (`RECIPES` in `items/crafting.ts`).

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
- **Sticks** splash out of the bark on every chup that lands on a tree or a
  piece: one, 30% chance of two, flung towards your side.
- **Leaves** come from scooping foliage (left mouse on a canopy) and from
  pieces breaking down.

Dropped items are their own meshes (`log.glb`, `stick.glb`), hovering above
the ground, bobbing and slowly turning about the vertical so they are easy
to spot. Leaves are still a billboard of their icon until they get a mesh.
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
  lie about the **unnamed region** (uncommon) and **Halloween** (rare), in a
  range of sizes. A rock in the world is not scenery. It is a body with weight
  (a standard one is about 25 kg, more by the cube of its size; the dev stats
  show the mass of the one you aim at):
  - It lies perfectly still until something moves it, and stays where it
    lands or is left; it is never forgotten. It is drawn on its flat side, and
    stays on a slope a snowball would roll down. Dig the ground from under
    it and it falls.
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
  2.5 m/s (1.5 shaken), and leaves a big glossy stain (radius 1.1 m, 1.8 shaken)
  on whatever it hit, flat on that surface, lasting 90 s (28 at a time). Goo
  has two meshes: `goo.glb`, the puddle, in a slot, a container or on the ground,
  and `gooball.glb` in the hand. The slime look is a new see-through material
  ([`gooMaterial.ts`](packages/client/src/render/gooMaterial.ts)). The tuning
  numbers are `VESSELS` in `vessel.ts`.
- **Xmas lights** (the basic rope; `xmas_lights`, stacks to 255): wound up
  in a coil as an item, held in the fist. Equipped, left mouse ties it; see
  [Xmas lights](#xmas-lights-rope-and-bulb-glow) below.
- **Leaf**: pinched in the fingers (a small billboard of its icon for now).
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
other. One string is used up. Between the clicks the string is held out
from the first tie to the loose end, which follows your aim: on the surface
you are looking at while that is within reach, otherwise hovering about 2.5 m
in front of you, never further from the first tie than the string reaches
(it stretches taut and the prompt says "too far"). You can only tie the end
to a surface in reach, not to the air. A string reaches up to 5 m between its
ends, with no minimum (tied end to end it lies in a heap). It is cut a hair
shorter than the gap (`slack` in `RopeSpec`, -1%), so it is stretched like
elastic and hangs with only a little sag.

**Running strings on.** With more strings in the stack, **right mouse**
(after the first end is tied) adds another string to the one being placed:
reach goes up by 5 m each time, up to 6 strings (30 m), as far as the stack
goes. This ties nothing; it is one longer rope, with 9 more segments per
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
(within 45 m) go into one pool of shader uniforms, and the terrain shader
and every Lambert material (trees, props, the player model, the arm; wrapped
with `litByBulbs()`) add a soft coloured pool of light on top of their own
lighting, red, green or blue, 1.8 m across with a smooth falloff that wraps
round the far side like vertex lighting did. It is additive, so it shows at
night and barely in daylight. The post-processing (bloom, colour bleed) is
still to come and will sit on top. Tuning knobs: `BULB_LIGHT_RADIUS`,
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
the tree is not lit again when its chunk reloads, and a tree that streams in
already cut has none). Pick them up with E like any item.

### The generation sheet

[`generationSheet.ts`](packages/shared/src/worldgen/generationSheet.ts) is the
one file to tune the world from. It has a section for each region:

- what spawns there, each as `common`, `uncommon` or `rare`
  (`BIOME_SHEET`);
- how hilly, cliffy or flat the ground is (`TERRAIN`);
- per-object rows (`OBJECT_SHEET`): what swinging at a snowman gets you, what
  a container holds, how flat the ground must be under it;
- `lootTable` per region: what turns up in its containers and in its
  gingerbread houses. Christmas has one (xmas lights, mowden lightning,
  eggnog, snowball, log, stick, coal, metal, candy, each with a rarity); the other regions
  have none yet. Names with no item behind them yet are skipped.

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
| **Unnamed** | Flat, gently hilly, and big cartoony multi-tiered bluffs. | Broadleaf trees, bushes, rocks (uncommon). |

**The third region needs a name and a purpose.** Today it is just "plain":
the ground between the two holiday regions, with a forest of broadleaf trees.
"Forest" is the working guess, but the bluffs suggest something more like
hill country; decide what it is for and what lives there, then fill in its
`BIOME_SHEET` section.

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

### Known gaps

- Rocks: they are shoved by walkers, swings and other rolling balls, but not
  yet by thrown sticks, thrown logs (Jolt bodies), a flying snowball or a
  trampoline; they are spheres, so one never tips or rests on a corner; and
  nothing breaks them. They are not on the map.
- Props are not solid to the player, except snowmen, gingerbread houses (and
  snowbanks, which are stood on); for the rest only the aiming raycast sees them.
- Gingerbread houses are never walked into: they are a solid box until they
  explode, and a flying snowball or thrown log can pass through the gaps in it.
  The container inside cannot be reached before then.
- Graves: an open one has a pit cut for it, but a covered one is left as solid
  ground under its topsoil (a hole there would be a trapdoor on the mound).
  The pit is cut when the topsoil comes off, which does not exist yet.
- Prop sizes and which way a mesh faces are first guesses (see the `scale`
  and `up` fields in `props.ts`).
- The first-person arm (`render/armViewmodel.ts`) is a single right arm with
  fixed lighting, not tied to the biome. Which face of the palm is the inside is
  unrecorded in the mesh: if the fingers curl backwards on the scoop, flip
  `PALM_SIGN`.
- Xmas lights: no tying to players, a
  tied string's anchor on a chopped tree stays in the air, no wiring for power
  yet, and no looser elastic variant yet (the elastic law and colliders are
  general, but only players bump a string: snowballs, logs, thrown things do
  not yet). Each segment is its own mesh (no
  instancing), so a forest of lit trees costs draw calls. Coils on the ground
  or in a hand glow but light nothing, snowball, log and skateboard meshes
  do not take the bulb light, and the glow does not twinkle or follow
  day/night. They are not yet placed as loot in the Christmas region
  (`generationSheet.ts`), only strung on trees.
- The load cap is now five vertical chunks, for the cliffs and bluffs.

- Terrain voxels are not checked for support, so cut-away ground can float.
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
  crafting result box is a stub.
- The default load radius is unmeasured on real hardware; check FPS before
  trusting it.

## Tests

`tools/golden/golden.json` holds reference data some of the shared tests
assert against (hashes, terrain, player movement). If one fails, the code is
wrong until proven otherwise — don't regenerate the file to make it pass.

Rope, inventory stacking, the bulb-light picker and the tree-light rolls have
tests next to the code (`rope.test.ts`, `inventory.test.ts`, `treeLights.test.ts`
in `shared`; `ropeView.test.ts`, `bulbLights.test.ts`, `treeLights.test.ts` in
`client`). The shader side of the glow has no test; check it by eye on both
backends (`?gl` forces WebGL2).

Items now stack to 255 per slot (`MAX_STACK` in `inventory.ts`); adding more
than fits spills into new slots, and an add that cannot fit all of it is
refused whole.
