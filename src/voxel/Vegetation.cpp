#include "Vegetation.hpp"

#include <algorithm>
#include <cstdint>

#include "TerrainGenerator.hpp"
#include "Voxel.hpp"

namespace fgp {
namespace {

// Placement grid: one candidate point per whole chunk column (3.2m), jittered
// to a random spot inside it, so vegetation reads as scattered rather than
// gridded. A single slot per chunk keeps this genuinely sparse — smaller
// cells kept producing tight clusters where neighboring canopies merged into
// a solid wall of foliage at head height.
constexpr int kCellSizeVoxels = kChunkSize;
constexpr float kTreeChance = 0.12f;
constexpr float kBushChance = 0.20f;

constexpr float kBushSizeMinVoxels = 4.0f;
constexpr float kBushSizeMaxVoxels = 8.0f;

// FNV-1a-style bit mixer; only needs to be well-distributed, not
// cryptographic, so placement/shape look scattered rather than gridded.
std::uint32_t hash32(std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d) {
    std::uint32_t h = 0x811C9DC5u;
    auto mix = [&h](std::uint32_t v) {
        h ^= v;
        h *= 0x01000193u;
        h ^= h >> 15;
    };
    mix(a);
    mix(b);
    mix(c);
    mix(d);
    return h;
}

// [0, 1) from a hash, using the top 24 bits for a clean float mantissa.
float hashFloat(std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d) {
    return static_cast<float>(hash32(a, b, c, d) >> 8) * (1.0f / 16777216.0f);
}

float lerp(float a, float b, float t) { return a + (b - a) * t; }

// A cross of two vertical quads (classic "always seen from any horizontal
// angle" foliage-sprite trick). Normal is forced up rather than using each
// quad's true (horizontal) geometric normal, so both visible sides of the
// cross get the same lighting instead of one reading near-black — draw-time
// face culling is disabled for this the same way main.cpp already does for
// the placeholder player mesh, so winding doesn't matter here either.
std::vector<Vertex> buildBushMesh(std::uint32_t bushHash) {
    const float sizeVoxels = lerp(kBushSizeMinVoxels, kBushSizeMaxVoxels, hashFloat(bushHash, 11, 0, 0));
    const float size = sizeVoxels * kVoxelSize;
    const float half = size * 0.5f;
    const float shade = lerp(0.85f, 1.15f, hashFloat(bushHash, 12, 0, 0));
    const glm::vec3 color(shade, shade, shade);
    const glm::vec3 normal(0.0f, 1.0f, 0.0f);

    std::vector<Vertex> out;
    out.reserve(12);

    auto pushPlane = [&](glm::vec3 c0, glm::vec3 c1, glm::vec3 c2, glm::vec3 c3) {
        out.push_back({c0, color, {0.0f, 0.0f}, normal});
        out.push_back({c1, color, {1.0f, 0.0f}, normal});
        out.push_back({c2, color, {1.0f, 1.0f}, normal});
        out.push_back({c0, color, {0.0f, 0.0f}, normal});
        out.push_back({c2, color, {1.0f, 1.0f}, normal});
        out.push_back({c3, color, {0.0f, 1.0f}, normal});
    };

    pushPlane({-half, 0.0f, 0.0f}, {half, 0.0f, 0.0f}, {half, size, 0.0f}, {-half, size, 0.0f});
    pushPlane({0.0f, 0.0f, -half}, {0.0f, 0.0f, half}, {0.0f, size, half}, {0.0f, size, -half});

    return out;
}

} // namespace

VegetationPlacementBatch generateVegetation(const TerrainGenerator& generator, ChunkCoord coord, int seed,
                                             const TreeSeveredLookup& severedLookup) {
    VegetationPlacementBatch batch;

    const glm::ivec3 chunkOrigin = coord * kChunkSize;
    const auto uSeed = static_cast<std::uint32_t>(seed);

    for (int cellZ = 0; cellZ < kChunkSize; cellZ += kCellSizeVoxels) {
        for (int cellX = 0; cellX < kChunkSize; cellX += kCellSizeVoxels) {
            const int cellWorldX = chunkOrigin.x + cellX;
            const int cellWorldZ = chunkOrigin.z + cellZ;

            const float jitterX = hashFloat(static_cast<std::uint32_t>(cellWorldX), static_cast<std::uint32_t>(cellWorldZ), uSeed, 0);
            const float jitterZ = hashFloat(static_cast<std::uint32_t>(cellWorldX), static_cast<std::uint32_t>(cellWorldZ), uSeed, 1);
            const int worldX = cellWorldX + std::min(kCellSizeVoxels - 1, static_cast<int>(jitterX * kCellSizeVoxels));
            const int worldZ = cellWorldZ + std::min(kCellSizeVoxels - 1, static_cast<int>(jitterZ * kCellSizeVoxels));

            const int surface = generator.surfaceHeight(worldX, worldZ);
            const int ownerLayer = floorDiv(surface, kChunkSize);
            if (ownerLayer != coord.y) {
                // This column's surface belongs to a different vertical
                // chunk layer; that layer's load will place it instead.
                continue;
            }

            const float roll = hashFloat(static_cast<std::uint32_t>(worldX), static_cast<std::uint32_t>(worldZ), uSeed, 2);
            const glm::vec3 root((static_cast<float>(worldX) + 0.5f) * kVoxelSize, static_cast<float>(surface) * kVoxelSize,
                                  (static_cast<float>(worldZ) + 0.5f) * kVoxelSize);

            if (roll < kTreeChance) {
                const std::uint32_t treeHash = hash32(static_cast<std::uint32_t>(worldX), static_cast<std::uint32_t>(worldZ), uSeed, 3);
                batch.trees.push_back(generateTreePlacement(treeHash, root, severedLookup(treeHash)));
            } else if (roll < kTreeChance + kBushChance) {
                const std::uint32_t bushHash = hash32(static_cast<std::uint32_t>(worldX), static_cast<std::uint32_t>(worldZ), uSeed, 4);
                batch.bushes.push_back(VegetationPlacement{root, buildBushMesh(bushHash)});
            }
        }
    }

    return batch;
}

} // namespace fgp
