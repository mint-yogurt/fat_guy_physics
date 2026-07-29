#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <vector>

#include <glm/glm.hpp>

#include "Chunk.hpp"
#include "ChunkMesh.hpp"
#include "TreeVoxels.hpp"

namespace fgp {

class TerrainGenerator;

// One bush: a self-contained mesh in bush-local space (root at the origin,
// sitting on the ground), drawn by translating to `origin`. Trees used to
// share this (decorative-only, no collision/identity — see TreeVoxels.hpp
// for what replaced that), bushes still work this way since nothing needs
// to interact with them yet.
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
    std::vector<TreePlacement> trees;
    std::vector<VegetationPlacement> bushes;
};

// Looks up whether a tree (identified by generateVegetation's placement
// hash) was previously chup-severed, and at what local Y, so a chunk that
// streams back in regenerates a stump instead of an intact tree. See
// World::treeSeveredBand.
using TreeSeveredLookup = std::function<std::optional<int>(std::uint32_t treeHash)>;

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
// Pure CPU work (noise + voxel/vertex generation, no GL calls), so this is
// safe to call from a worker thread — including severedLookup, which must
// itself be safe to call concurrently from multiple worker threads (see
// World::treeSeveredBand's locking).
VegetationPlacementBatch generateVegetation(const TerrainGenerator& generator, ChunkCoord coord, int seed,
                                             const TreeSeveredLookup& severedLookup);

} // namespace fgp
