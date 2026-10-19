#pragma once

// A stand-in for src/voxel/World.hpp, used ONLY by the golden-data dumper.
//
// The real World owns ChunkMesh (OpenGL), Vegetation, and a std::thread
// pool, none of which a headless dumper can or should link against. But
// Collision.cpp and Player.cpp -- the two files whose behaviour the port
// most needs pinned -- touch World through a three-method surface:
// isSolidIncludingSnappedLogs, materialAt, and surfaceHeightVoxels.
//
// So the dumper compiles the *real, unmodified* Collision.cpp and Player.cpp
// against this header instead (see dump-golden.sh, which stages them in a
// directory where this World.hpp shadows the real one). The behaviour under
// test is the genuine article; only the terrain storage around it is
// simplified -- chunks are generated on demand by the real TerrainGenerator
// and cached forever, which for a dumper is strictly better than streaming.
//
// There are no snapped log grids here. The real
// isSolidIncludingSnappedLogs also consults felled logs that happened to
// land square with the voxel lattice; that is a documented stopgap being
// replaced at M8, and the terrain half is what M4 needs to pin.

#include <memory>
#include <unordered_map>

#include <glm/glm.hpp>

// Angle-bracket form so these resolve to the REAL headers via -I<repo>/src
// rather than to staged copies -- two copies of the same header at different
// paths defeat #pragma once and redefine every class in them.
#include <voxel/Chunk.hpp>
#include <voxel/TerrainGenerator.hpp>
#include <voxel/Voxel.hpp>

namespace fgp {

class World {
public:
    explicit World(int seed) : generator_(seed) {}

    int surfaceHeightVoxels(int worldX, int worldZ) const {
        return generator_.surfaceHeight(worldX, worldZ);
    }

    Material materialAt(glm::ivec3 worldVoxel) const {
        const ChunkCoord coord{
            floorDiv(worldVoxel.x, kChunkSize),
            floorDiv(worldVoxel.y, kChunkSize),
            floorDiv(worldVoxel.z, kChunkSize),
        };
        // Matches the real World: anything outside the streamed vertical
        // band reads as Air, so the dumper reproduces the same "you can
        // fall out of the bottom of the world" behaviour the port has.
        if (coord.y < 0 || coord.y > 3) {
            return Material::Air;
        }
        const Chunk& chunk = chunkAt(coord);
        return chunk.at(floorMod(worldVoxel.x, kChunkSize),
                        floorMod(worldVoxel.y, kChunkSize),
                        floorMod(worldVoxel.z, kChunkSize));
    }

    bool isSolidIncludingSnappedLogs(glm::ivec3 worldVoxel) const {
        return isSolid(materialAt(worldVoxel));
    }

private:
    const Chunk& chunkAt(ChunkCoord coord) const {
        const auto it = chunks_.find(coord);
        if (it != chunks_.end()) {
            return *it->second;
        }
        auto chunk = std::make_unique<Chunk>(coord);
        generator_.generate(*chunk);
        const Chunk& ref = *chunk;
        chunks_.emplace(coord, std::move(chunk));
        return ref;
    }

    TerrainGenerator generator_;
    mutable std::unordered_map<ChunkCoord, std::unique_ptr<Chunk>, ChunkCoordHash> chunks_;
};

} // namespace fgp
