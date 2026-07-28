#include "Vegetation.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>

#include <FastNoiseLite.h>

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

// Trunk height is the tunable "tree size" knob; canopy dimensions scale off
// of it so retuning is a one-line edit. The minimum is set well above the
// 1.9m player height (with kCanopyTrunkOverlap below kept small) so the
// canopy always starts clear overhead instead of at head/shoulder height —
// 24-44 voxels of trunk puts total tree height at roughly 3.1-7.4m.
constexpr float kTrunkHeightMinVoxels = 24.0f;
constexpr float kTrunkHeightMaxVoxels = 44.0f;
constexpr float kTrunkRadiusMinVoxels = 1.1f;
constexpr float kTrunkRadiusMaxVoxels = 2.0f;
constexpr float kCanopyRadiusScaleMin = 1.0f;
constexpr float kCanopyRadiusScaleMax = 1.6f;
constexpr float kCanopyHeightScaleMin = 1.2f;
constexpr float kCanopyHeightScaleMax = 1.8f;
// Fraction of trunk height the canopy's base dips below the trunk top —
// just enough that the canopy visually meets the trunk instead of floating
// above it, not enough to drag foliage down toward head height.
constexpr float kCanopyTrunkOverlap = 0.08f;
constexpr float kCanopyMaxRadiusVoxels = 32.0f;
constexpr float kCanopyMaxHeightVoxels = 42.0f;
constexpr float kCanopyNoiseFrequency = 0.2f;
constexpr float kCanopyNoiseAmplitude = 0.35f;

constexpr float kBushSizeMinVoxels = 4.0f;
constexpr float kBushSizeMaxVoxels = 8.0f;

const glm::vec3 kTrunkBaseColor(0.36f, 0.24f, 0.15f);
const glm::vec3 kFoliageBaseColor(0.25f, 0.48f, 0.17f);

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

// Cheap baked shading matching ChunkMesher::faceTint, so scenery reads with
// the same directional brightness cue as terrain instead of looking flat.
float axisTint(int axis, bool negative) {
    if (axis == 1) return negative ? 0.5f : 1.0f;
    return axis == 0 ? 0.65f : 0.8f;
}

// Emits one quad on the plane axis `d` at `planeCoord`, spanning
// [uMin,uMax] x [vMin,vMax] on the other two axes (u=(d+1)%3, v=(d+2)%3,
// same cyclic convention as ChunkMesher::emitQuad, so cross(du,dv) always
// points toward +d and backFace reverses winding the same way). UV always
// spans 0..1 regardless of quad size: single voxel faces tile once (same as
// terrain), and box faces (the trunk) stretch once across the whole face.
void emitPlaneQuad(std::vector<Vertex>& out, int d, bool backFace, float planeCoord, float uMin, float uMax,
                    float vMin, float vMax, glm::vec3 color, float tint) {
    const int u = (d + 1) % 3;
    const int v = (d + 2) % 3;

    glm::vec3 c0(0.0f);
    glm::vec3 c1(0.0f);
    glm::vec3 c2(0.0f);
    glm::vec3 c3(0.0f);
    c0[d] = c1[d] = c2[d] = c3[d] = planeCoord;
    c0[u] = uMin;
    c0[v] = vMin;
    c1[u] = uMax;
    c1[v] = vMin;
    c2[u] = uMax;
    c2[v] = vMax;
    c3[u] = uMin;
    c3[v] = vMax;

    glm::vec3 normal(0.0f);
    normal[d] = backFace ? -1.0f : 1.0f;

    const glm::vec3 tinted = color * tint;
    const glm::vec2 uv0(0.0f, 0.0f);
    const glm::vec2 uv1(1.0f, 0.0f);
    const glm::vec2 uv2(1.0f, 1.0f);
    const glm::vec2 uv3(0.0f, 1.0f);

    if (!backFace) {
        out.push_back({c0, tinted, uv0, normal});
        out.push_back({c1, tinted, uv1, normal});
        out.push_back({c2, tinted, uv2, normal});
        out.push_back({c0, tinted, uv0, normal});
        out.push_back({c2, tinted, uv2, normal});
        out.push_back({c3, tinted, uv3, normal});
    } else {
        out.push_back({c0, tinted, uv0, normal});
        out.push_back({c2, tinted, uv2, normal});
        out.push_back({c1, tinted, uv1, normal});
        out.push_back({c0, tinted, uv0, normal});
        out.push_back({c3, tinted, uv3, normal});
        out.push_back({c2, tinted, uv2, normal});
    }
}

// Emits the box [minCorner,maxCorner], skipping faces where exposed[2*d +
// (positive?1:0)] is false. Used both for the trunk (a single box, all
// faces exposed) and for individual foliage voxels (neighbor-culled).
void emitBoxFaces(std::vector<Vertex>& out, glm::vec3 minCorner, glm::vec3 maxCorner, glm::vec3 color,
                   const bool exposed[6]) {
    for (int d = 0; d < 3; ++d) {
        const int u = (d + 1) % 3;
        const int v = (d + 2) % 3;
        if (exposed[2 * d + 1]) {
            emitPlaneQuad(out, d, false, maxCorner[d], minCorner[u], maxCorner[u], minCorner[v], maxCorner[v], color,
                          axisTint(d, false));
        }
        if (exposed[2 * d + 0]) {
            emitPlaneQuad(out, d, true, minCorner[d], minCorner[u], maxCorner[u], minCorner[v], maxCorner[v], color,
                          axisTint(d, true));
        }
    }
}

// Trunk (a plain box, per ideas' "one big rectangular mesh for now") plus a
// noise-shaped voxel canopy sitting on top of it. Everything is built in
// tree-local space with the root at the base of the trunk.
std::vector<Vertex> buildTreeMesh(std::uint32_t treeHash) {
    std::vector<Vertex> out;

    const float trunkHeightVoxels = lerp(kTrunkHeightMinVoxels, kTrunkHeightMaxVoxels, hashFloat(treeHash, 1, 0, 0));
    const float trunkRadiusVoxels = lerp(kTrunkRadiusMinVoxels, kTrunkRadiusMaxVoxels, hashFloat(treeHash, 2, 0, 0));
    const float trunkShade = lerp(0.85f, 1.15f, hashFloat(treeHash, 3, 0, 0));

    const float trunkHeight = trunkHeightVoxels * kVoxelSize;
    const float trunkRadius = trunkRadiusVoxels * kVoxelSize;
    const glm::vec3 trunkColor = kTrunkBaseColor * trunkShade;

    {
        const bool exposed[6] = {true, true, true, true, true, true};
        emitBoxFaces(out, glm::vec3(-trunkRadius, 0.0f, -trunkRadius), glm::vec3(trunkRadius, trunkHeight, trunkRadius),
                     trunkColor, exposed);
    }

    const float canopyRadiusVoxels = std::min(
        kCanopyMaxRadiusVoxels, trunkHeightVoxels * lerp(kCanopyRadiusScaleMin, kCanopyRadiusScaleMax, hashFloat(treeHash, 4, 0, 0)));
    const float canopyHeightVoxels = std::min(
        kCanopyMaxHeightVoxels, trunkHeightVoxels * lerp(kCanopyHeightScaleMin, kCanopyHeightScaleMax, hashFloat(treeHash, 5, 0, 0)));
    const float canopyBaseVoxels = trunkHeightVoxels * (1.0f - kCanopyTrunkOverlap);

    // Grid needs headroom beyond the nominal canopy size since lobes below
    // are offset off-center.
    const int gridRadius = static_cast<int>(std::ceil(canopyRadiusVoxels * 1.4f));
    const int gridHeight = static_cast<int>(std::ceil(canopyHeightVoxels * 1.3f));

    FastNoiseLite noise;
    noise.SetSeed(static_cast<int>(treeHash));
    noise.SetNoiseType(FastNoiseLite::NoiseType_Perlin);
    noise.SetFractalType(FastNoiseLite::FractalType_FBm);
    noise.SetFractalOctaves(2);
    noise.SetFrequency(kCanopyNoiseFrequency);

    // The canopy is a union of a handful of independently offset and sized
    // "lobes" rather than one smooth tapered ellipsoid — a single blob reads
    // as too regular/lightbulb-shaped no matter how much surface noise gets
    // layered on it; a few overlapping asymmetric clumps is what actually
    // breaks up the silhouette into something tree-like.
    struct Lobe {
        glm::vec3 centerVoxels;
        float radiusVoxels;
        float heightRadiusVoxels;
    };
    const int lobeCount = 3 + static_cast<int>(hashFloat(treeHash, 6, 0, 0) * 2.5f); // 3-5
    std::vector<Lobe> lobes;
    lobes.reserve(static_cast<std::size_t>(lobeCount));
    for (int i = 0; i < lobeCount; ++i) {
        const std::uint32_t li = static_cast<std::uint32_t>(20 + i * 4);
        const float ox = (hashFloat(treeHash, li + 0, 0, 0) - 0.5f) * canopyRadiusVoxels;
        const float oz = (hashFloat(treeHash, li + 1, 0, 0) - 0.5f) * canopyRadiusVoxels;
        const float oy = hashFloat(treeHash, li + 2, 0, 0) * canopyHeightVoxels * 0.75f;
        const float lobeRadius = canopyRadiusVoxels * lerp(0.5f, 0.85f, hashFloat(treeHash, li + 3, 0, 0));
        const float lobeHeightRadius = canopyHeightVoxels * lerp(0.4f, 0.7f, hashFloat(treeHash, li + 3, 1, 0));
        lobes.push_back(Lobe{glm::vec3(ox, oy, oz), lobeRadius, lobeHeightRadius});
    }

    const int dim = 2 * gridRadius + 1;
    std::vector<std::uint8_t> occupancy(static_cast<std::size_t>(dim) * dim * gridHeight, 0);
    auto index = [&](int lx, int ly, int lz) {
        return (static_cast<std::size_t>(ly) * dim + static_cast<std::size_t>(lz + gridRadius)) * dim +
               static_cast<std::size_t>(lx + gridRadius);
    };
    auto isOccupied = [&](int lx, int ly, int lz) {
        if (lx < -gridRadius || lx > gridRadius || lz < -gridRadius || lz > gridRadius || ly < 0 || ly >= gridHeight) {
            return false;
        }
        return occupancy[index(lx, ly, lz)] != 0;
    };

    // Union of lobe ellipsoid distance fields, each perturbed by noise so
    // no single lobe's boundary is a clean ellipsoid either — "not too
    // blocky or round" per the brief.
    for (int ly = 0; ly < gridHeight; ++ly) {
        for (int lz = -gridRadius; lz <= gridRadius; ++lz) {
            for (int lx = -gridRadius; lx <= gridRadius; ++lx) {
                const float n = noise.GetNoise(static_cast<float>(lx), static_cast<float>(ly), static_cast<float>(lz));
                const float threshold = 1.0f + n * kCanopyNoiseAmplitude;

                bool inside = false;
                for (const Lobe& lobe : lobes) {
                    const float dx = (static_cast<float>(lx) + 0.5f - lobe.centerVoxels.x) / lobe.radiusVoxels;
                    const float dz = (static_cast<float>(lz) + 0.5f - lobe.centerVoxels.z) / lobe.radiusVoxels;
                    const float dy = (static_cast<float>(ly) + 0.5f - lobe.centerVoxels.y) / lobe.heightRadiusVoxels;
                    const float dist = std::sqrt(dx * dx + dy * dy + dz * dz);
                    if (dist < threshold) {
                        inside = true;
                        break;
                    }
                }
                if (inside) {
                    occupancy[index(lx, ly, lz)] = 1;
                }
            }
        }
    }

    const glm::vec3 canopyLocalOrigin(0.0f, canopyBaseVoxels * kVoxelSize, 0.0f);
    for (int ly = 0; ly < gridHeight; ++ly) {
        for (int lz = -gridRadius; lz <= gridRadius; ++lz) {
            for (int lx = -gridRadius; lx <= gridRadius; ++lx) {
                if (!isOccupied(lx, ly, lz)) {
                    continue;
                }
                const bool exposed[6] = {
                    !isOccupied(lx - 1, ly, lz), !isOccupied(lx + 1, ly, lz),
                    !isOccupied(lx, ly - 1, lz), !isOccupied(lx, ly + 1, lz),
                    !isOccupied(lx, ly, lz - 1), !isOccupied(lx, ly, lz + 1),
                };

                // Different coordinate offset than the shape noise above so
                // color variance isn't perfectly correlated with the
                // occupancy boundary.
                const float colorNoise =
                    noise.GetNoise(static_cast<float>(lx) + 1000.0f, static_cast<float>(ly), static_cast<float>(lz) + 1000.0f);
                const float shade = lerp(0.8f, 1.15f, (colorNoise + 1.0f) * 0.5f);
                const glm::vec3 color = kFoliageBaseColor * shade;

                const glm::vec3 minCorner = canopyLocalOrigin + glm::vec3(lx, ly, lz) * kVoxelSize;
                const glm::vec3 maxCorner = minCorner + glm::vec3(kVoxelSize);
                emitBoxFaces(out, minCorner, maxCorner, color, exposed);
            }
        }
    }

    return out;
}

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

VegetationPlacementBatch generateVegetation(const TerrainGenerator& generator, ChunkCoord coord, int seed) {
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
                batch.trees.push_back(VegetationPlacement{root, buildTreeMesh(treeHash)});
            } else if (roll < kTreeChance + kBushChance) {
                const std::uint32_t bushHash = hash32(static_cast<std::uint32_t>(worldX), static_cast<std::uint32_t>(worldZ), uSeed, 4);
                batch.bushes.push_back(VegetationPlacement{root, buildBushMesh(bushHash)});
            }
        }
    }

    return batch;
}

} // namespace fgp
