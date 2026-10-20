# assets/meshes

Model assets, glTF 2.0 binary (`.glb`) format.

- `playermodel_v1.glb` — the player body mesh. If present, loaded at
  startup in place of the procedural placeholder sphere (see
  `src/PlayerMesh.hpp`), and used for both walking and ragball modes since
  it has no animation yet. Expected to be a single mesh, any node
  hierarchy; the loader ignores materials/textures entirely and paints the
  whole mesh a flat color passed in by the caller (currently
  `kPlayerBodyColor` in `main.cpp`, same as the old placeholder sphere).
- `player_arm_fpv.glb` - the first-person arm (`packages/client/src/render/armViewmodel.ts`).
  Seven labelled parts, flat nodes, +Y shoulder to fingertip, thumb sticking out +X:
  `arm.upper`, `forearm`, `hand/palm`, `fingers.base`, `fingers.tips`, `thumb.base`,
  `thumb.tips`. The fingers move as one mass (base and tips only), so the loader looks
  parts up by these names (punctuation stripped, as GLTFLoader does) and fails if one is
  missing. The thumb is folded up beside the fingers at rest for the chop.
