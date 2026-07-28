#pragma once

#include <array>
#include <cstddef>
#include <functional>

#include <glm/glm.hpp>

#include "Voxel.hpp"

namespace fgp {

using ChunkCoord = glm::ivec3;

// Hashes a ChunkCoord for use as an unordered_map key (World's chunk table).
struct ChunkCoordHash {
    std::size_t operator()(const ChunkCoord& coord) const noexcept {
        std::size_t h = 0;
        auto mix = [&h](int v) {
            h ^= std::hash<int>{}(v) + 0x9e3779b9 + (h << 6) + (h >> 2);
        };
        mix(coord.x);
        mix(coord.y);
        mix(coord.z);
        return h;
    }
};

// Fixed-size (kChunkSize^3) grid of voxels. Storage only — generation lives
// in TerrainGenerator, meshing in ChunkMesher.
class Chunk {
public:
    explicit Chunk(ChunkCoord coord) : coord_(coord) {}

    ChunkCoord coord() const { return coord_; }

    // World-space position of this chunk's (0,0,0) voxel corner.
    glm::vec3 worldOrigin() const {
        return glm::vec3(coord_) * (static_cast<float>(kChunkSize) * kVoxelSize);
    }

    Material at(int x, int y, int z) const { return voxels_[index(x, y, z)]; }
    void set(int x, int y, int z, Material material) { voxels_[index(x, y, z)] = material; }

    static bool inBounds(int x, int y, int z) {
        return x >= 0 && x < kChunkSize && y >= 0 && y < kChunkSize && z >= 0 && z < kChunkSize;
    }

private:
    static std::size_t index(int x, int y, int z) {
        return static_cast<std::size_t>(x) +
               static_cast<std::size_t>(y) * kChunkSize +
               static_cast<std::size_t>(z) * kChunkSize * kChunkSize;
    }

    ChunkCoord coord_;
    std::array<Material, static_cast<std::size_t>(kChunkSize) * kChunkSize * kChunkSize> voxels_{};
};

} // namespace fgp
