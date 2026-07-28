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

// CPU-only counterpart to VegetationInstance: vertex data plus the origin
// it should be translated to, without a GPU mesh attached yet. This is what
// worker threads produce, since ChunkMesh's constructor makes GL calls and
// GL is only valid on the main thread — the caller uploads each of these
// into a real ChunkMesh once it's back on that thread.
struct VegetationPlacement {
    glm::vec3 origin;
    std::vector<Vertex> vertices;
};

struct VegetationPlacementBatch {
    std::vector<VegetationPlacement> trees;
    std::vector<VegetationPlacement> bushes;
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
//
// Pure CPU work (noise + vertex generation, no GL calls), so this is safe
// to call from a worker thread.
VegetationPlacementBatch generateVegetation(const TerrainGenerator& generator, ChunkCoord coord, int seed);

} // namespace fgp
