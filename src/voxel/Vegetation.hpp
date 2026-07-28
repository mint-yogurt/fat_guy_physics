#pragma once

#include <memory>
#include <vector>

#include <glm/glm.hpp>

#include "Chunk.hpp"
#include "ChunkMesh.hpp"

namespace fgp {

class TerrainGenerator;

// One piece of scattered scenery (a tree or a bush): a self-contained mesh
// in tree/bush-local space (root at the origin, sitting on the ground),
// drawn by translating to `origin`. Since each instance carries its own
// translation rather than being folded into its owning chunk's mesh,
// foliage is free to overhang past the chunk's column footprint.
struct VegetationInstance {
    glm::vec3 origin;
    std::unique_ptr<ChunkMesh> mesh;
};

struct VegetationBatch {
    std::vector<VegetationInstance> trees;
    std::vector<VegetationInstance> bushes;
};

// Deterministically scatters trees/bushes across one chunk's column
// footprint, keyed off (world column, seed) so a chunk that streams out and
// back in regenerates the same forest instead of a new random one.
//
// World::update loads every vertical chunk layer for a given column (see
// World.hpp's fixed vertical band), so without a tie-breaker every layer
// would spawn its own copy of the same tree. Each column's vegetation is
// therefore only spawned by the one chunk layer whose Y range contains that
// column's surface voxel; every other layer skips it.
VegetationBatch generateVegetation(const TerrainGenerator& generator, ChunkCoord coord, int seed);

} // namespace fgp
