# assets/meshes

Model assets, glTF 2.0 binary (`.glb`) format.

- `playermodel_v1.glb` — the player body mesh. If present, loaded at
  startup in place of the procedural placeholder sphere (see
  `src/PlayerMesh.hpp`), and used for both walking and ragball modes since
  it has no animation yet. Expected to be a single mesh, any node
  hierarchy; the loader ignores materials/textures entirely and paints the
  whole mesh a flat color passed in by the caller (currently
  `kPlayerBodyColor` in `main.cpp`, same as the old placeholder sphere).
