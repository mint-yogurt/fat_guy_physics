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

Click to capture the mouse. WASD walk, Space jump, left mouse scoops terrain,
right mouse chops, R toggles Ragball, V first/third person, `-`/`=` FOV,
1-9 hotbar.

### URL flags

- `?gl` — force the WebGL2 backend instead of WebGPU.
- `?radius=N` — override the chunk load radius (default 12 chunks, about 38 m).

## Packages

npm workspaces under `packages/`:

- **`@fgp/shared`** — the simulation. No three.js, no DOM, no browser APIs,
  so the authoritative server can run it unchanged.
- **`@fgp/client`** — Vite + three.js (`WebGPURenderer`, falling back to
  WebGL2) + `jolt-physics`.
- **`@fgp/synth`** — sound engine. Standalone, not yet wired in; see its
  [README](packages/synth/README.md).
- **`@fgp/server`** — Node + ws. Not written yet.

## Status

Done: chunked terrain streamed through a worker pool, player controller and
collision, Jolt rigid bodies, trees you can fell, items and hotbar, player
rig and character create, biome field with ground colour, sky, light and
snow, per-region terrain height (rolling hills, cliffs, tiered bluffs), and
scattered props: snowmen, presents, tombstones and graves, and a
first-person arm that scoops and chops.

Next: pre-made generative structures (flat ground, with resources clustered
round them), the grave-topsoil tool, post-processing, multiplayer.

### The generation sheet

[`generationSheet.ts`](packages/shared/src/worldgen/generationSheet.ts) is the
one file to tune the world from. It has a section for each region:

- what spawns there, each as `common`, `uncommon` or `rare`
  (`BIOME_SHEET`);
- how hilly, cliffy or flat the ground is (`TERRAIN`);
- per-object rows (`OBJECT_SHEET`): what swinging at a snowman gets you, what
  a container holds, how flat the ground must be under it;
- `containerLoot` per region -- the place to say "eggnog in Christmas
  presents", once there is an eggnog item. It is empty for now on purpose.

Adding a mesh: put the `.glb` in `assets/meshes`, add its metrics to
[`props.ts`](packages/shared/src/worldgen/props.ts) and its materials' looks to
`propAssets.ts`, then list it under a region.

### Regions

| Region | Ground | Spawns |
| --- | --- | --- |
| Christmas | Flat, with gentle rolling hills. | Conifers, bushes, snowmen (two sizes; sticks), presents (two sizes; containers). |
| Halloween | Flat sections, and cliffs that jut out of them. | Dead trees, a few autumn-coloured broadleaf trees, tombstones (two kinds), graves. |
| **Unnamed** | Flat, gently hilly, and big cartoony multi-tiered bluffs. | Broadleaf trees, bushes. |

**The third region needs a name and a purpose.** Today it is just "plain":
the ground between the two holiday regions, with a forest of broadleaf trees.
"Forest" is the working guess, but the bluffs suggest something more like
hill country; decide what it is for and what lives there, then fill in its
`BIOME_SHEET` section.

Height is the game's progression: the player cannot climb a cliff or a bluff
face, so getting up to what is on top means building something to get there.

Graves are cut into the ground, and a covered one (most of them) is hidden
under topsoil. Removing the topsoil needs a tool the player does not have yet.

### Known gaps

- Props are not solid to the player; only the aiming raycast sees them.
- Graves: an open one has a pit cut for it, but a covered one is left as solid
  ground under its topsoil (a hole there would be a trapdoor on the mound).
  The pit is cut when the topsoil comes off, which does not exist yet.
- Prop sizes and which way a mesh faces are first guesses (see the `scale`
  and `up` fields in `props.ts`).
- The first-person arm (`render/armViewmodel.ts`) is a single right arm with
  fixed lighting, not tied to the biome. Which face of the palm is the inside is
  unrecorded in the mesh: if the fingers curl backwards on the scoop, flip
  `PALM_SIGN`.
- The load cap is now five vertical chunks, for the cliffs and bluffs.

- Terrain voxels are not checked for support, so cut-away ground can float.
- Debris particles are not in yet.
- Face textures exist but character create's face option does nothing.
- The walking collider is an AABB, not a swept capsule.
- A felled tree collides as a trunk-width capsule, so its canopy is walked
  through. Standing trees are solid to the aiming raycast only, not the player.
- The default load radius is unmeasured on real hardware; check FPS before
  trusting it.

## Tests

`tools/golden/golden.json` holds reference data some of the shared tests
assert against (hashes, terrain, player movement). If one fails, the code is
wrong until proven otherwise — don't regenerate the file to make it pass.
