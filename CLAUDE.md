# Working notes for Claude

## Verification

- Never take screenshots to verify something (it wastes tokens) without the user's explicit permission each time. Permission for one screenshot does not carry over to the next.
- Prefer text-based checks instead: typecheck, tests, console messages, logs, `read_page` / `get_page_text`, or reasoning about the code.

## Keeping this map current (token budget)

This file exists so you do not re-read the codebase every session. Use the map below to go straight to the right files; read only those, and only the part you need (`offset`/`limit`, or Grep first). Do not sweep `main.ts` or `world.ts` front to back.

**Broad searches go to a subagent.** If the map does not tell you where something lives and finding it would take more than a couple of Grep/Read calls (sweeping many files, tracing a feature across packages, "where is X used"), spawn an `Explore` subagent with a specific question and ask for file paths, line numbers and a short summary back. It reads in its own context, so only the summary costs tokens here. Do not do the sweep yourself. Do read the files you are about to edit directly; the subagent finds them, you edit them.

**Maintenance rule:** when you add, remove, rename or repurpose a file, system, item, or integration point, update this file in the same change. One line per file, pointer-style, no prose. If you had to do broad exploration because the map was missing or wrong, fix the map before finishing. Keep the whole file under ~150 lines: if it grows, cut detail, not accuracy. Do not duplicate what README.md/DESIGN.md already say; link to them.

## Project

TypeScript browser game on the `web-port` branch (npm workspaces, Node 20+). `README.md` = controls, status, feature behavior, known gaps. `DESIGN.md` = design intent. `ideas` and `NEW SHIT TO ADD.txt` = the user's scratch notes, ignore unless asked.

Commands (repo root): `npm run dev` (client, :5173), `npm run typecheck`, `npm test` (vitest, `packages/*/src/**/*.test.ts`), `npm run build`. URL flags: `?gl`, `?radius=N`, `?debug=0|1`.

**Ignore these (legacy / generated / vendored):** `src/`, `CMakeLists.txt`, `cmake/`, `build/`, `third_party/` (the old C++ build; the web port ports from it, comments say "ports src/X.cpp"; only read the C++ if a task says to match it), `tools/golden/` (reference data for shared tests: if a test using `golden.json` fails the code is wrong, never regenerate it), `node_modules/`, `packages/*/dist*`, `*.tsbuildinfo`, `package-lock.json`, `assets/` binaries.

## Packages

- `packages/shared` (`@fgp/shared`): the simulation. **No DOM, no three.js, no browser APIs** (tsconfig has no DOM lib, so the future Node server can run it). No `enum`s (use `const` objects). Fixed timestep, allocation-free hot paths.
- `packages/client` (`@fgp/client`): Vite + three.js (import from `"three/webgpu"` only, never `"three"`) + `jolt-physics`. Rendering, input, UI, Jolt bodies.
- `packages/synth` (`@fgp/synth`): sound synth (patch code -> samples), used by the client's `audio/`. Own README and demo (`npm run synth`).
- `@fgp/server`: not written yet.

## shared/src (the sim)

- `sim/world.ts` (1128 lines, `World`): chunk streaming (`update`, `drain`), voxel queries (`isSolid`, `materialAt`, `topSolid`), digging (`digSphere`), trees (`getTree`, `treesNear`, `chopTree`, `stripFoliage`), props (`propsNear`, `harvestProp`), vegetation spawn (`spawnVegetation`). Grep for the method; do not read whole.
- `sim/player.ts` (`Player`): walk/ragball/skating movement, look state, `PlayerInput`. `sim/skate.ts` (`SkateState`): skateboard riding, called from `Player.updateSkating`.
- `sim/collision.ts`: voxel AABB/sphere sweeps (near-verbatim C++ port; epsilons are deliberate). `sim/sceneQuery.ts` (`SceneSolidQuery`): terrain + oriented cylinders (felled logs) + snowbank mounds as one solid query. `sim/mound.ts`: snowbank mesh as a height field (`MoundList`, `moundHeight`). `sim/constants.ts`: `VOXEL_SIZE`, `CHUNK_SIZE`, `FIXED_TIMESTEP`. `sim/chunkSource.ts`, `chunkKey.ts`, `time.ts`: chunk generation seam, key packing, clock.
- `items/inventory.ts`: `ItemType` (Stick, Leaf, Log, Trampoline, Skateboard, Snowball, XmasLights, Rock, 3 containers, MountainLightning, Eggnog, Coal, Goo, Metal, Candy), `ITEM_NAMES`, `MAX_STACK` (255), `Inventory` (slot 0 = Unarmed, hotbar 1-8, 16-slot backpack, `version` bumps on change).
- `items/avatarPose.ts`: `AvatarPose` (held item + action + throw charge; packs to 4 bytes for multiplayer), `HoldStyle` per item (Blade/Carry/Pinch/Empty), swing cycle constants, `ThrowWatcher`.
- `items/snowball.ts`: rolled snowballs (`Snowball`/`SnowballField`: roll, grow on snow, settle as terrain features, ball-ball collision, shoved by walkers via `pushedBy`/`yieldTo`, harvest/shrink, 5-min despawn), `ThrownSnowballs` (put throws + bursts), `TrunkQuery`.
- `items/rock.ts`: rocks = heavy balls in the same `SnowballField` (`STONE` `RollMaterial`; `placeRock` for the world's, `spawnRock` for thrown). World places them via `PropMetrics.dynamic` -> `ChunkSink.onRockPlaced` -> `WorldRenderer.onRock` (main.ts). `Snowball.shove`/`pushedBy(..., walkerMass)`/`reaction` = weight-aware hits. Drawn by `snowballView.ts`.
- `items/rolledItems.ts`: items used like a rock (rock, eggnog carton): `ROLLED_ITEMS` rows (material + radius), `rolledItemOf`, `itemOfBall`, `spawnRolled`. New one = a row + a mesh (`snowballView.ts`).
- `items/vessel.ts`: can of mowden lightning (item id `mountain_lightning`) + goo: `VESSELS` (throw speeds, burst speed, splash, stain), `Shake` (LMB), `ThrownVessels` (flight; `splats` burst, `landings` become pickups). Client: `render/vesselView.ts`, `render/gooMaterial.ts` (slime material, `GooStains`), `GOO_BURST` in `snow.ts`, `burstVessel` in `main.ts`.
- `items/rope.ts`: xmas lights/rope. `RopeSpec` (`XMAS_LIGHTS`), `planRope`, `Rope` (XPBD chain, terrain collision, pulls tied `RopeBody`s), `RopeField`, `BallRopeBody`. Add a new rope kind = new `RopeSpec`.
- `sim/elastic.ts`: **the one elasticity engine**: `ElasticMaterial` + `elasticForce` (spring, hardens past max strain), `ElasticCollider` (anything bumpable) + `boxPushOut`/`spherePushOut`. Ropes (`RopeSpec extends ElasticMaterial`) take colliders in `step`; `sim/playerBody.ts` = the player's. New elastic thing = material + shape, no new physics. `Player.applyImpulse` = shove from outside.
- `items/itemCursor.ts` (`ItemCursor`): the stack on the mouse; click/cancel rules over any `ItemGrid` (interface in `inventory.ts`: `Inventory`, `ContainerStorage`, `CraftingBench`). `items/container.ts`: the 3 containers (`CONTAINER_ITEMS`, `ContainerField` = contents by prop id, `inContainerReach`); they are world props (`World.addProp`/`removeProp`, placed ones persist per chunk column). `items/crafting.ts`: `CraftingBench` (growing `_ + _` boxes), `RECIPES` empty = stub.
- `sim/propDamage.ts`: props made of parts (snowmen): `PROP_DAMAGE` per blow, `sectionAtHeight`, `sectionTouching`, `propColliders` (solid cylinders for the player and `TrunkQuery`). Part data = `PROP_SECTIONS` in `worldgen/props.ts`; state/rules = `World.damageProp`, `Prop.broken`; `World.harvestPropYield` also shrinks/removes a `depletes` snowbank. Client: `PropRenderer.onSectionBroken` -> `render/flyingChunks.ts` -> burst (`SnowFlakeBurst` in `render/snow.ts`); `hurtProp` in `main.ts` is the one place every blow goes through.
- Gingerbread houses (`PropMetrics.breakable`): one health bar, `World.damageBreakable`, explode when spent; solid as a box (`propBox`, `SceneSolidQuery.boxes`); one item in `Prop.loot` + 20% a container, both from the biome `lootTable` (`spawns.ts` `placeStructure`, `rollInterior`; rows in `OBJECT_SHEET.interior`). Client: `PropRenderer.onShattered` -> `render/shatter.ts` (triangles fly off); `hurtHouse` in `main.ts`; hit crumbs = `SnowFlakeBurst` with `CRUMB_BURST`.
- `items/placement.ts`: **placing**. `PLACEMENTS` (per placeable item: footprint, height, `hideHeldInFirstPerson`), `placementOf`, `PlacementPlanner.plan` -> `PlacementPlan` (spot, yaw, valid + why). New placeable = a row here + a ghost in `placementPreview.ts` + a case in `placeHeld` (main.ts).
- `items/pickupField.ts` (`PickupField`): dropped items on scalar gravity, E pickup. `items/trampoline.ts` (`TrampolineField`): placed trampoline rules, bounce energy.
- `map/mapData.ts` (`MapData`): explored-area map texture data.
- `voxel/`: `voxel.ts` (`Material`, predicates), `voxelGrid.ts`, `greedyMesher.ts`, `vertexLayout.ts`, `voxelRaycast.ts`, `biomeTint.ts`.
- `worldgen/`: **`generationSheet.ts` = the one file to tune the world** (per-biome spawn tables, terrain shape, object loot/yields). `terrainGenerator.ts`, `biome.ts` (`BiomeField`), `spawns.ts` (placement), `trees.ts` (species metrics), `props.ts` (prop metrics, grave box), `graveCarve.ts`. `rng/hash.ts`: deterministic hashing (`Math.imul` matters).

## client/src (rendering, input, UI)

- `main.ts` (1146 lines): **everything is wired here, inside one `start()` function** (line ~209). Roughly: constants at top (throw/chop/dig tuning, ~90-175) -> construct systems (~215-390) -> `throwLog`/action helpers (~439) -> the frame loop: fixed-step `player.update` (~646), `world.update` (~680), input -> avatar pose and item actions/E pickup (~700-1020), then `thrown`/`pickups`/`logs` updates (~934-1022), then render updates (skateboard, playerModel, arm, atmosphere, snow, leaves, ~1040-1072). Find the spot with Grep, then read ~60 lines around it.
- `debug.ts`: `DEBUG` flag; with it on, the player starts with a trampoline and skateboard.
- `input/inputState.ts` (`InputState`): keyboard, mouse, pointer lock.
- `physics/`: `physicsWorld.ts` (Jolt wrapper), `logSystem.ts` (felled tree pieces, logs; tuning constants at top), `thrownSticks.ts`, `trampolineSystem.ts` (meshes + static bodies for mats), `ropeBodies.ts` (`PieceRopeBody`: rope tied to a felled piece).
- `render/` first-person/third-person: `armViewmodel.ts` (FPV arm and its poses/grips), `playerModel.ts` (third-person rig, per-vertex arm bending, `HOLD_AIM` etc.), `playerCamera.ts`, `heldItems.ts` (hand-held item meshes per `HoldStyle`), `skateboardView.ts`, `snowballView.ts` (rolled/flying snowballs + `SnowPuffs`), `ropeView.ts` (xmaslights.glb parts, `RopeChain` segments w/ bulbs hanging down, `buildCoil` item look, `RopesView`), `treeLights.ts` (xmas lights strung on Christmas conifers, `treeStringPath`; hooked via `TreeRenderer.lights`), `bulbLights.ts` (bulb glow pool: nearest bulbs as uniforms, `bulbGlow` TSL fn used by `voxelMaterial.ts`, `litByBulbs()` on every Lambert node material).
- `render/` world: `worldRenderer.ts` (chunk meshes), `treeRenderer.ts` + `treeAssets.ts` + `sliceGeometry.ts` (chopping/felling), `propRenderer.ts` + `propAssets.ts`, `pickupRenderer.ts` (dropped items), `itemAssets.ts` (item GLBs), `hotbarItems.ts` (3D items in hotbar), `atmosphere.ts` (sky/light/biome blend), `snow.ts`, `leaves.ts`, `voxelMaterial.ts`, `chunkGeometry.ts`, `meshOrientation.ts` (flips inside-out GLBs), `renderer.ts`.
- `audio/`: `sfxBank.ts` (name -> synth patch code; `sfx.md` at repo root documents each sound and where it fires: edit both, a test checks they match), `gameAudio.ts` (`GameAudio.play(name, {gain,pitch,variance,chord})`), `triggers.ts` (pure: `StrideTracker`, `landingGain`, `RisingEdge`, `AmbienceScheduler`). Sim events reach audio as counters (`Player.respawns`, `SkateState.bails/ollies/flips/flipsLanded/pushes`) or return values (`TrampolineField.afterPlayerStep`); grep `audio.play` in `main.ts`.
- `render/placementPreview.ts` (`PlacementPreview`): green/red translucent ghost of the held placeable (`GHOSTS` per item; keeps map + alpha test, so it is also the transparent-material code). `armViewmodel.ts` hides a placeable from the first-person hand.
- `ui/inventoryScreen.ts` (I key; DOM for borders/clicks, fills + 3D items drawn by a second `HotbarItems` pass; wired in `main.ts` via `openInventory`/`closeInventory`). `render/containerLook.ts`: empty present = black top face, empty bucket hides `filling`; item meshes of containers.
- `ui/`: `controlHints.ts` (bottom-right keycaps per held item, `controlHintsFor`), `hotbar.ts`, `hud.ts`, `mapView.ts`, `characterCreate.ts`, `trickBanner.ts` (centre-screen trick graphic), `ui.css`. `workers/`: `chunkWorker.ts`, `workerChunkSource.ts` (terrain gen/meshing off-thread).
- Tests sit next to the code as `*.test.ts` (shared: player, world, skate, trampoline, avatarPose, pickupField, spawns, terrain, hash, mapData; client: sliceGeometry, meshOrientation).

## Assets

`assets/meshes/*.glb` (items, props, trees, player rig), `assets/icons/`, `assets/textures/`. Adding a prop mesh: GLB in `assets/meshes`, metrics in `shared/worldgen/props.ts`, materials in `client/render/propAssets.ts`, list under a region in `generationSheet.ts` (README has the full steps).

## Recipe: adding an item (touch these, then stop exploring)

1. `shared/items/inventory.ts`: add to `ItemType` and `ITEM_NAMES`.
2. `shared/items/avatarPose.ts`: give it a `HoldStyle`.
3. `client/render/heldItems.ts`: mesh builder in that style's frame (`itemAssets.ts` if it needs a loaded GLB).
4. `client/render/hotbarItems.ts` and `pickupRenderer.ts`: hotbar view and ground look (colour/mesh).
5. `client/main.ts`: behaviour (grep `ItemType.Skateboard` / `ItemType.Trampoline` for the existing patterns), and `debug.ts` to grant it for testing.
6. A new kind of hold/action also needs a pose in both `armViewmodel.ts` and `playerModel.ts`.
6b. A placed item (mat, container, later logs/plywood): add it to `PLACEMENTS` in `shared/items/placement.ts`, a ghost in `render/placementPreview.ts`, and a case in `placeHeld` in `main.ts`.
7. Put the item's rules in `shared/` (with a test), not in `main.ts`, so the server can run them. Update README's feature text if behaviour is user-facing.
