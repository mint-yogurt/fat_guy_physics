#include "TreeVoxels.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <limits>

#include <FastNoiseLite.h>

namespace fgp {

namespace {

// Same shape/randomization ranges Vegetation.cpp's old buildTreeMesh used
// — trunk height is the tunable "tree size" knob, canopy dimensions scale
// off of it.
constexpr float kTrunkHeightMinVoxels = 24.0f;
constexpr float kTrunkHeightMaxVoxels = 44.0f;
constexpr float kTrunkRadiusMinVoxels = 1.1f;
constexpr float kTrunkRadiusMaxVoxels = 2.0f;
constexpr float kCanopyRadiusScaleMin = 1.0f;
constexpr float kCanopyRadiusScaleMax = 1.6f;
constexpr float kCanopyHeightScaleMin = 1.2f;
constexpr float kCanopyHeightScaleMax = 1.8f;
constexpr float kCanopyTrunkOverlap = 0.08f;
constexpr float kCanopyMaxRadiusVoxels = 32.0f;
constexpr float kCanopyMaxHeightVoxels = 42.0f;
constexpr float kCanopyNoiseFrequency = 0.2f;
constexpr float kCanopyNoiseAmplitude = 0.35f;

// FNV-1a-style bit mixer; only needs to be well-distributed, not
// cryptographic (same as Vegetation.cpp's placement hash).
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

float hashFloat(std::uint32_t a, std::uint32_t b, std::uint32_t c, std::uint32_t d) {
    return static_cast<float>(hash32(a, b, c, d) >> 8) * (1.0f / 16777216.0f);
}

float lerp(float a, float b, float t) { return a + (b - a) * t; }

// Trims an occupancy-sparse grid down to its occupied bounding box (worst
// case before this, a full canopy grid is ~91x91x55 cells/tree — most of
// it empty border). Degenerates to a single Air cell if nothing is
// occupied (e.g. a tree severed at its very base).
void shrinkToOccupiedBounds(TreeVoxelGrid& grid) {
    glm::ivec3 minG(grid.dims);
    glm::ivec3 maxG(-1, -1, -1);
    for (int gy = 0; gy < grid.dims.y; ++gy) {
        for (int gz = 0; gz < grid.dims.z; ++gz) {
            for (int gx = 0; gx < grid.dims.x; ++gx) {
                if (grid.cells[grid.index({gx, gy, gz})] != Material::Air) {
                    minG = glm::min(minG, glm::ivec3(gx, gy, gz));
                    maxG = glm::max(maxG, glm::ivec3(gx, gy, gz));
                }
            }
        }
    }

    if (maxG.x < minG.x) {
        grid.dims = glm::ivec3(1, 1, 1);
        grid.originLocal = glm::ivec3(0, 0, 0);
        grid.cells.assign(1, Material::Air);
        return;
    }

    TreeVoxelGrid shrunk;
    shrunk.dims = maxG - minG + glm::ivec3(1);
    shrunk.originLocal = grid.originLocal - minG;
    shrunk.cells.assign(static_cast<std::size_t>(shrunk.dims.x) * shrunk.dims.y * shrunk.dims.z, Material::Air);
    for (int gy = minG.y; gy <= maxG.y; ++gy) {
        for (int gz = minG.z; gz <= maxG.z; ++gz) {
            for (int gx = minG.x; gx <= maxG.x; ++gx) {
                const Material m = grid.cells[grid.index({gx, gy, gz})];
                if (m != Material::Air) {
                    shrunk.cells[shrunk.index({gx - minG.x, gy - minG.y, gz - minG.z})] = m;
                }
            }
        }
    }
    grid = std::move(shrunk);
}

// Cheap baked shading matching ChunkMesher::faceTint/Vegetation.cpp's old
// axisTint, so tree geometry reads with the same directional brightness
// cue as terrain.
float axisTint(int axis, bool negative) {
    if (axis == 1) return negative ? 0.5f : 1.0f;
    return axis == 0 ? 0.65f : 0.8f;
}

void emitPlaneQuad(std::vector<Vertex>& out, int d, bool backFace, float planeCoord, float uMin, float uMax,
                    float vMin, float vMax, glm::vec3 color, float tint) {
    const int u = (d + 1) % 3;
    const int v = (d + 2) % 3;

    glm::vec3 c0(0.0f), c1(0.0f), c2(0.0f), c3(0.0f);
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
    const glm::vec2 uv0(0.0f, 0.0f), uv1(1.0f, 0.0f), uv2(1.0f, 1.0f), uv3(0.0f, 1.0f);

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

} // namespace

TreePlacement generateTreePlacement(std::uint32_t treeHash, glm::vec3 rootWorld,
                                     std::optional<int> severedAtLocalY) {
    const float trunkHeightVoxelsF = lerp(kTrunkHeightMinVoxels, kTrunkHeightMaxVoxels, hashFloat(treeHash, 1, 0, 0));
    const float trunkRadiusVoxels = lerp(kTrunkRadiusMinVoxels, kTrunkRadiusMaxVoxels, hashFloat(treeHash, 2, 0, 0));

    int trunkHeightVoxels = static_cast<int>(std::ceil(trunkHeightVoxelsF));
    const bool hasCanopy = !severedAtLocalY.has_value();
    if (severedAtLocalY) {
        trunkHeightVoxels = std::clamp(*severedAtLocalY, 0, trunkHeightVoxels);
    }

    const float canopyRadiusVoxels = std::min(
        kCanopyMaxRadiusVoxels, trunkHeightVoxelsF * lerp(kCanopyRadiusScaleMin, kCanopyRadiusScaleMax, hashFloat(treeHash, 4, 0, 0)));
    const float canopyHeightVoxels = std::min(
        kCanopyMaxHeightVoxels, trunkHeightVoxelsF * lerp(kCanopyHeightScaleMin, kCanopyHeightScaleMax, hashFloat(treeHash, 5, 0, 0)));
    const float canopyBaseVoxels = trunkHeightVoxelsF * (1.0f - kCanopyTrunkOverlap);

    const int trunkLoopRadius = static_cast<int>(std::ceil(trunkRadiusVoxels)) + 1;
    const int gridRadius = hasCanopy ? static_cast<int>(std::ceil(canopyRadiusVoxels * 1.4f)) : trunkLoopRadius;
    const int canopyGridHeight = hasCanopy ? static_cast<int>(std::ceil(canopyHeightVoxels * 1.3f)) : 0;
    const int canopyYOffset = static_cast<int>(std::floor(canopyBaseVoxels));
    const int gridHeightTotal =
        std::max(1, hasCanopy ? std::max(trunkHeightVoxels, canopyYOffset + canopyGridHeight) : trunkHeightVoxels);

    TreeVoxelGrid grid;
    grid.dims = glm::ivec3(2 * gridRadius + 1, gridHeightTotal, 2 * gridRadius + 1);
    grid.originLocal = glm::ivec3(gridRadius, 0, gridRadius);
    grid.cells.assign(static_cast<std::size_t>(grid.dims.x) * grid.dims.y * grid.dims.z, Material::Air);

    // Trunk: a rasterized cylinder, radius trunkRadiusVoxels, height
    // trunkHeightVoxels. Loop bounded tightly around the trunk's own
    // radius rather than the (possibly much larger) canopy-driven
    // gridRadius.
    for (int ly = 0; ly < trunkHeightVoxels; ++ly) {
        for (int lz = -trunkLoopRadius; lz <= trunkLoopRadius; ++lz) {
            for (int lx = -trunkLoopRadius; lx <= trunkLoopRadius; ++lx) {
                const float dx = static_cast<float>(lx) + 0.5f;
                const float dz = static_cast<float>(lz) + 0.5f;
                if (dx * dx + dz * dz <= trunkRadiusVoxels * trunkRadiusVoxels) {
                    grid.set(glm::ivec3(lx, ly, lz), Material::Wood);
                }
            }
        }
    }

    if (hasCanopy) {
        FastNoiseLite noise;
        noise.SetSeed(static_cast<int>(treeHash));
        noise.SetNoiseType(FastNoiseLite::NoiseType_Perlin);
        noise.SetFractalType(FastNoiseLite::FractalType_FBm);
        noise.SetFractalOctaves(2);
        noise.SetFrequency(kCanopyNoiseFrequency);

        // Union of a handful of independently offset/sized "lobes" rather
        // than one smooth ellipsoid — reads as tree-like instead of a
        // lightbulb silhouette (see Vegetation.cpp's old comment on this).
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

        for (int ly = 0; ly < canopyGridHeight; ++ly) {
            for (int lz = -gridRadius; lz <= gridRadius; ++lz) {
                for (int lx = -gridRadius; lx <= gridRadius; ++lx) {
                    const float n = noise.GetNoise(static_cast<float>(lx), static_cast<float>(ly), static_cast<float>(lz));
                    const float threshold = 1.0f + n * kCanopyNoiseAmplitude;

                    bool inside = false;
                    for (const Lobe& lobe : lobes) {
                        const float dx = (static_cast<float>(lx) + 0.5f - lobe.centerVoxels.x) / lobe.radiusVoxels;
                        const float dz = (static_cast<float>(lz) + 0.5f - lobe.centerVoxels.z) / lobe.radiusVoxels;
                        const float dy = (static_cast<float>(ly) + 0.5f - lobe.centerVoxels.y) / lobe.heightRadiusVoxels;
                        if (std::sqrt(dx * dx + dy * dy + dz * dz) < threshold) {
                            inside = true;
                            break;
                        }
                    }
                    if (!inside) {
                        continue;
                    }

                    const glm::ivec3 local(lx, canopyYOffset + ly, lz);
                    // Don't overwrite trunk (Wood) — this is the small
                    // deliberate overlap (kCanopyTrunkOverlap) where the
                    // canopy visually meets the trunk instead of floating
                    // above it.
                    if (grid.at(local) == Material::Air) {
                        grid.set(local, Material::Leaf);
                    }
                }
            }
        }
    }

    shrinkToOccupiedBounds(grid);

    TreePlacement placement;
    placement.rootWorld = rootWorld;
    placement.voxels = grid;
    placement.meshVertices = buildTreeVoxelMesh(grid);
    placement.treeHash = treeHash;
    placement.trunkHeightVoxels = trunkHeightVoxels;
    placement.trunkRadiusVoxels = trunkRadiusVoxels;
    placement.severed = severedAtLocalY.has_value();
    return placement;
}

std::vector<Vertex> buildTreeVoxelMesh(const TreeVoxelGrid& grid) {
    std::vector<Vertex> out;

    const auto occupiedAt = [&](glm::ivec3 g) {
        if (g.x < 0 || g.x >= grid.dims.x || g.y < 0 || g.y >= grid.dims.y || g.z < 0 || g.z >= grid.dims.z) {
            return false;
        }
        return grid.cells[grid.index(g)] != Material::Air;
    };

    for (int gy = 0; gy < grid.dims.y; ++gy) {
        for (int gz = 0; gz < grid.dims.z; ++gz) {
            for (int gx = 0; gx < grid.dims.x; ++gx) {
                const glm::ivec3 g(gx, gy, gz);
                const Material material = grid.cells[grid.index(g)];
                if (material == Material::Air) {
                    continue;
                }

                const bool exposed[6] = {
                    !occupiedAt(g - glm::ivec3(1, 0, 0)), !occupiedAt(g + glm::ivec3(1, 0, 0)),
                    !occupiedAt(g - glm::ivec3(0, 1, 0)), !occupiedAt(g + glm::ivec3(0, 1, 0)),
                    !occupiedAt(g - glm::ivec3(0, 0, 1)), !occupiedAt(g + glm::ivec3(0, 0, 1)),
                };

                const glm::ivec3 local = g - grid.originLocal;
                const glm::vec3 minCorner = glm::vec3(local) * kVoxelSize;
                const glm::vec3 maxCorner = minCorner + glm::vec3(kVoxelSize);
                emitBoxFaces(out, minCorner, maxCorner, materialColor(material), exposed);
            }
        }
    }

    return out;
}

std::optional<glm::ivec3> raycastVoxelGrid(const TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation,
                                            glm::vec3 originWorld, glm::vec3 direction, float maxDistanceMeters) {
    const glm::quat invRotation = glm::inverse(gridRotation);
    const glm::vec3 originLocal = invRotation * (originWorld - gridPosition);
    const glm::vec3 dirWorld = glm::length(direction) > 0.0f ? glm::normalize(direction) : glm::vec3(0.0f, 0.0f, -1.0f);
    const glm::vec3 dir = invRotation * dirWorld;

    glm::ivec3 voxel(static_cast<int>(std::floor(originLocal.x / kVoxelSize)),
                      static_cast<int>(std::floor(originLocal.y / kVoxelSize)),
                      static_cast<int>(std::floor(originLocal.z / kVoxelSize)));

    glm::ivec3 step(0);
    glm::vec3 tMax(0.0f);
    glm::vec3 tDelta(0.0f);

    for (int axis = 0; axis < 3; ++axis) {
        if (dir[axis] > 0.0f) {
            step[axis] = 1;
            const float voxelBoundary = static_cast<float>(voxel[axis] + 1) * kVoxelSize;
            tMax[axis] = (voxelBoundary - originLocal[axis]) / dir[axis];
            tDelta[axis] = kVoxelSize / dir[axis];
        } else if (dir[axis] < 0.0f) {
            step[axis] = -1;
            const float voxelBoundary = static_cast<float>(voxel[axis]) * kVoxelSize;
            tMax[axis] = (voxelBoundary - originLocal[axis]) / dir[axis];
            tDelta[axis] = kVoxelSize / -dir[axis];
        } else {
            step[axis] = 0;
            tMax[axis] = std::numeric_limits<float>::infinity();
            tDelta[axis] = std::numeric_limits<float>::infinity();
        }
    }

    float t = 0.0f;
    while (t <= maxDistanceMeters) {
        if (isSolid(grid.at(voxel))) {
            return voxel;
        }

        int axis = 0;
        if (tMax[1] < tMax[axis]) axis = 1;
        if (tMax[2] < tMax[axis]) axis = 2;

        voxel[axis] += step[axis];
        t = tMax[axis];
        tMax[axis] += tDelta[axis];
    }

    return std::nullopt;
}

std::vector<glm::ivec3> digVoxelGridSphere(TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation,
                                            glm::vec3 centerWorld, float radiusMeters) {
    const glm::vec3 centerLocal = glm::inverse(gridRotation) * (centerWorld - gridPosition);
    const glm::ivec3 centerVoxel(static_cast<int>(std::floor(centerLocal.x / kVoxelSize)),
                                  static_cast<int>(std::floor(centerLocal.y / kVoxelSize)),
                                  static_cast<int>(std::floor(centerLocal.z / kVoxelSize)));
    const int r = static_cast<int>(std::ceil(radiusMeters / kVoxelSize));

    std::vector<glm::ivec3> cleared;
    for (int dz = -r; dz <= r; ++dz) {
        for (int dy = -r; dy <= r; ++dy) {
            for (int dx = -r; dx <= r; ++dx) {
                const glm::ivec3 local = centerVoxel + glm::ivec3(dx, dy, dz);
                const glm::vec3 voxelCenterLocal = (glm::vec3(local) + 0.5f) * kVoxelSize;
                if (glm::length(voxelCenterLocal - centerLocal) > radiusMeters) {
                    continue;
                }
                if (grid.at(local) == Material::Leaf) {
                    grid.set(local, Material::Air);
                    cleared.push_back(local);
                }
            }
        }
    }
    return cleared;
}

TreeVoxelGrid severVoxelGridAt(TreeVoxelGrid& grid, int severLocalY) {
    TreeVoxelGrid& below = grid;
    TreeVoxelGrid above;
    above.dims = below.dims;
    above.originLocal = below.originLocal;
    above.cells.assign(below.cells.size(), Material::Air);

    for (int gy = 0; gy < below.dims.y; ++gy) {
        const int localY = gy - below.originLocal.y;
        if (localY < severLocalY) {
            continue;
        }
        for (int gz = 0; gz < below.dims.z; ++gz) {
            for (int gx = 0; gx < below.dims.x; ++gx) {
                const std::size_t idx = below.index({gx, gy, gz});
                if (below.cells[idx] != Material::Air) {
                    above.cells[idx] = below.cells[idx];
                    below.cells[idx] = Material::Air;
                }
            }
        }
    }

    shrinkToOccupiedBounds(below);
    shrinkToOccupiedBounds(above);

    return above;
}

ChopResult chopVoxelGrid(TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation, glm::vec3 centerWorld,
                          float horizontalRadiusMeters, float verticalHalfThicknessMeters) {
    ChopResult result;

    const glm::vec3 centerLocal = glm::inverse(gridRotation) * (centerWorld - gridPosition);
    const glm::ivec3 centerVoxel(static_cast<int>(std::floor(centerLocal.x / kVoxelSize)),
                                  static_cast<int>(std::floor(centerLocal.y / kVoxelSize)),
                                  static_cast<int>(std::floor(centerLocal.z / kVoxelSize)));
    const int rXZ = static_cast<int>(std::ceil(horizontalRadiusMeters / kVoxelSize));
    const int rY = static_cast<int>(std::ceil(verticalHalfThicknessMeters / kVoxelSize));

    int minTouchedY = std::numeric_limits<int>::max();
    int maxTouchedY = std::numeric_limits<int>::min();

    for (int dy = -rY; dy <= rY; ++dy) {
        for (int dz = -rXZ; dz <= rXZ; ++dz) {
            for (int dx = -rXZ; dx <= rXZ; ++dx) {
                const glm::ivec3 local = centerVoxel + glm::ivec3(dx, dy, dz);
                const glm::vec3 voxelCenterLocal = (glm::vec3(local) + 0.5f) * kVoxelSize;

                if (std::abs(voxelCenterLocal.y - centerLocal.y) > verticalHalfThicknessMeters) {
                    continue;
                }
                const float dxw = voxelCenterLocal.x - centerLocal.x;
                const float dzw = voxelCenterLocal.z - centerLocal.z;
                if (dxw * dxw + dzw * dzw > horizontalRadiusMeters * horizontalRadiusMeters) {
                    continue;
                }

                const Material m = grid.at(local);
                // isSolid guard is required, not redundant: isChoppable is
                // isHandDiggable-or-Wood, and isHandDiggable deliberately
                // returns true for Air (scoop's terrain-digging use) — the
                // same footgun World.cpp already guards against at its own
                // isHandDiggable call site. Without it, nearly every Air
                // cell in the disc's bounding box (most of it, for a thin
                // cylindrical trunk) would count as "cleared."
                if (isSolid(m) && isChoppable(m)) {
                    grid.set(local, Material::Air);
                    (m == Material::Wood ? result.clearedWoodVoxels : result.clearedLeafVoxels).push_back(local);
                    minTouchedY = std::min(minTouchedY, local.y);
                    maxTouchedY = std::max(maxTouchedY, local.y);
                }
            }
        }
    }

    if (result.clearedWoodVoxels.empty() && result.clearedLeafVoxels.empty()) {
        return result;
    }

    const auto bandHasWood = [&grid](int localY) {
        const int gy = localY + grid.originLocal.y;
        if (gy < 0 || gy >= grid.dims.y) {
            return false;
        }
        for (int gz = 0; gz < grid.dims.z; ++gz) {
            for (int gx = 0; gx < grid.dims.x; ++gx) {
                if (grid.cells[grid.index({gx, gy, gz})] == Material::Wood) {
                    return true;
                }
            }
        }
        return false;
    };

    // The severance scan's Y-range is the grid's OWN actual occupied-Wood
    // extent, not an assumed [0, height) range — see the header comment on
    // why a fixed lower bound of 0 breaks once a piece has been re-centered
    // around its own pivot (negative local Y becomes valid there).
    int woodMinY = std::numeric_limits<int>::max();
    int woodMaxY = std::numeric_limits<int>::min();
    for (int gy = 0; gy < grid.dims.y; ++gy) {
        const int localY = gy - grid.originLocal.y;
        if (bandHasWood(localY)) {
            woodMinY = std::min(woodMinY, localY);
            woodMaxY = std::max(woodMaxY, localY);
        }
    }

    if (woodMinY <= woodMaxY) {
        for (int y = std::max(woodMinY, minTouchedY); y <= std::min(woodMaxY, maxTouchedY); ++y) {
            if (!bandHasWood(y)) {
                result.severedAtLocalY = y;
                result.severedAbove = severVoxelGridAt(grid, y);
                break;
            }
        }
    }

    return result;
}

std::optional<glm::ivec3> raycastTree(const TreeInstance& tree, glm::vec3 originWorld, glm::vec3 direction,
                                       float maxDistanceMeters) {
    return raycastVoxelGrid(tree.voxels, tree.rootWorld, glm::quat(1.0f, 0.0f, 0.0f, 0.0f), originWorld, direction,
                             maxDistanceMeters);
}

std::vector<glm::ivec3> digTreeSphere(TreeInstance& tree, glm::vec3 centerWorld, float radiusMeters) {
    return digVoxelGridSphere(tree.voxels, tree.rootWorld, glm::quat(1.0f, 0.0f, 0.0f, 0.0f), centerWorld,
                               radiusMeters);
}

TreeVoxelGrid severTreeAt(TreeInstance& tree, int severLocalY) {
    TreeVoxelGrid above = severVoxelGridAt(tree.voxels, severLocalY);
    tree.severed = true;
    tree.trunkHeightVoxels = std::min(tree.trunkHeightVoxels, severLocalY);
    return above;
}

ChopResult chopTree(TreeInstance& tree, glm::vec3 centerWorld, float horizontalRadiusMeters,
                     float verticalHalfThicknessMeters) {
    ChopResult result = chopVoxelGrid(tree.voxels, tree.rootWorld, glm::quat(1.0f, 0.0f, 0.0f, 0.0f), centerWorld,
                                       horizontalRadiusMeters, verticalHalfThicknessMeters);
    if (result.severedAtLocalY) {
        tree.severed = true;
        tree.trunkHeightVoxels = std::min(tree.trunkHeightVoxels, *result.severedAtLocalY);
    }
    return result;
}

} // namespace fgp
