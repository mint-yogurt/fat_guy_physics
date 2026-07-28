#pragma once

#include <filesystem>
#include <optional>
#include <vector>

#include <glm/glm.hpp>

#include "voxel/ChunkMesher.hpp"

namespace fgp {

// Low-poly, unit-radius UV sphere centered at the origin (model space) —
// the placeholder player body. Not final art: DESIGN.md's player has small
// arms/legs and a face; this is just enough geometry to see the character
// exist and roll until that gets built. Reuses ChunkMesh's Vertex layout so
// it can upload straight into a ChunkMesh and draw with the existing basic
// shader (bind a flat white texture so only the vertex color shows).
std::vector<Vertex> buildPlayerSphereMesh(glm::vec3 color, int latSegments = 10, int lonSegments = 16);

// Loads a mesh from a glTF 2.0 file (.gltf or .glb) for use as the player
// body. Every node with a mesh is included (world-transformed by that
// node's transform), and the combined result is recentered on its
// bounding-box center and rescaled to a unit-radius bounding sphere — the
// same contract buildPlayerSphereMesh's output satisfies — so it drops
// into the existing translate(bodyCenter) * rotate * scale(bodyRadius)
// model matrix in main.cpp unchanged, regardless of the source mesh's
// authored scale or pivot. Per-vertex color comes from each primitive's
// material base_color_factor (white if no material); texture sampling
// isn't wired up yet, so a textured model will render flat white-tinted.
// Returns std::nullopt if the file doesn't exist or fails to parse.
std::optional<std::vector<Vertex>> loadPlayerMeshFromGltf(const std::filesystem::path& path);

} // namespace fgp
