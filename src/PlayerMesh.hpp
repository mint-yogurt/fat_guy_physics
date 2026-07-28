#pragma once

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

} // namespace fgp
