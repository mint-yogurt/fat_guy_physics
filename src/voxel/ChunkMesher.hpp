#pragma once

#include <vector>

#include <glm/glm.hpp>

#include "Chunk.hpp"

namespace fgp {

struct Vertex {
    glm::vec3 position;
    glm::vec3 color;
};

// Builds a greedy-meshed vertex list for a single chunk, in chunk-local
// space (meters, i.e. voxel index * kVoxelSize) — the caller translates by
// chunk.worldOrigin() when drawing. Only emits faces at solid/air
// boundaries; faces at the chunk's outer boundary are always emitted
// (neighbor chunks aren't consulted), which trades a small amount of
// hidden overdraw between adjacent chunks for not needing cross-chunk
// queries during meshing.
std::vector<Vertex> buildChunkMesh(const Chunk& chunk);

} // namespace fgp
