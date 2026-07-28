#pragma once

#include <cstdint>

#include <glm/glm.hpp>

namespace fgp {

// ~10cm per voxel (see DESIGN.md "Deformable terrain").
constexpr float kVoxelSize = 0.1f;

// Voxels per chunk edge; a chunk is a 3.2m cube of voxels.
constexpr int kChunkSize = 32;

// Full material list from DESIGN.md. Only a depth-based subset is placed by
// the Phase 1 heightmap generator (Dirt/Gravel/Rock/Granite); the rest are
// reserved for biome-driven generation (Phase 8) and excavation-hardness
// rules (Phase 2).
enum class Material : std::uint8_t {
    Air = 0,
    Sand,
    Snow,
    Dirt,
    Clay,
    Gravel,
    Rock,
    Granite,
    Ice,
};

inline bool isSolid(Material material) {
    return material != Material::Air;
}

// No tool/equipment system exists yet, so "hand digging" (Phase 2's scoop
// mechanic) can only remove soft materials; Rock/Granite/Ice require a
// future tool tier.
inline bool isHandDiggable(Material material) {
    switch (material) {
        case Material::Air:
        case Material::Sand:
        case Material::Snow:
        case Material::Dirt:
        case Material::Clay:
        case Material::Gravel:
            return true;
        case Material::Rock:
        case Material::Granite:
        case Material::Ice:
            return false;
    }
    return false;
}

glm::vec3 materialColor(Material material);

// Floor division/modulo (C++'s / and % truncate toward zero, not toward
// -infinity). Chunk coordinate math needs this for negative world voxel
// coordinates: Chunk::index() has no bounds check, so truncating division
// would silently corrupt memory instead of just being wrong.
inline int floorDiv(int a, int b) {
    int q = a / b;
    if ((a % b != 0) && ((a < 0) != (b < 0))) --q;
    return q;
}

inline int floorMod(int a, int b) {
    int r = a % b;
    if (r != 0 && ((r < 0) != (b < 0))) r += b;
    return r;
}

} // namespace fgp
