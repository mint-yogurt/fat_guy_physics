# assets/meshes

Model assets, glTF 2.0 binary (`.glb`) format.

- `player.glb` — the player body mesh. If present, loaded at startup in
  place of the procedural placeholder sphere (see `src/PlayerMesh.hpp`).
  Expected to be a single mesh, any node hierarchy; vertex colors come from
  each primitive's material `baseColorFactor` (no texture sampling yet).
