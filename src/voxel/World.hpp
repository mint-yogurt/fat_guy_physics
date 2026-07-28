#pragma once

#include <memory>
#include <unordered_map>

#include "Chunk.hpp"
#include "ChunkMesh.hpp"
#include "TerrainGenerator.hpp"
#include "../Shader.hpp"

namespace fgp {

// Streams chunks in a horizontal radius around a world-space position,
// generating + meshing + uploading new ones and dropping ones that fall
// out of range. Runs synchronously on the main thread (see Phase 1 scope
// notes — threaded generation is a later optimization pass).
//
// Vertical range is a fixed band rather than streamed: Phase 1's
// heightmap generator only ever produces terrain within a known,
// bounded Y range, so there's nothing above/below it to stream in.
// That stops being true once caves/full 3D density generation exist.
class World {
public:
    explicit World(int seed, int loadRadiusChunks = 6);

    void update(glm::vec3 cameraWorldPos);
    void draw(const Shader& shader) const;

    int surfaceHeightVoxels(int worldX, int worldZ) const { return generator_.surfaceHeight(worldX, worldZ); }

private:
    struct LoadedChunk {
        std::unique_ptr<Chunk> chunk;
        std::unique_ptr<ChunkMesh> mesh;
    };

    static constexpr int kVerticalChunkMin = 0;
    static constexpr int kVerticalChunkMax = 3; // covers generator's baseHeight_ +/- amplitude_ with margin

    void loadChunk(ChunkCoord coord);

    TerrainGenerator generator_;
    int loadRadiusChunks_;
    std::unordered_map<ChunkCoord, LoadedChunk, ChunkCoordHash> loaded_;
    bool hasCenter_ = false;
    int centerX_ = 0;
    int centerZ_ = 0;
};

} // namespace fgp
