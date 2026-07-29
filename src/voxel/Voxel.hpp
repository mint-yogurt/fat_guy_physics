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
// Wood/Leaf are tree materials (see voxel/TreeVoxels.hpp) — trees have
// their own per-tree voxel grid, not the terrain Chunk grid, but reuse this
// enum (rather than a parallel one) so isSolid()/materialColor() and any
// future "what's here" code don't need a second copy of that machinery.
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
    Wood,
    Leaf,
};

inline bool isSolid(Material material) {
    return material != Material::Air;
}

// No tool/equipment system exists yet, so "hand digging" (Phase 2's scoop
// mechanic) can only remove soft materials; Rock/Granite/Ice require a
// future tool tier. Leaf is scoop-removable (foliage); Wood (trunk) is not
// — trunks are chup-only, see isChoppable.
inline bool isHandDiggable(Material material) {
    switch (material) {
        case Material::Air:
        case Material::Sand:
        case Material::Snow:
        case Material::Dirt:
        case Material::Clay:
        case Material::Gravel:
        case Material::Leaf:
            return true;
        case Material::Rock:
        case Material::Granite:
        case Material::Ice:
        case Material::Wood:
            return false;
    }
    return false;
}

// Gates the "chup" (chop) action: the same hardness tier scoop already
// uses, plus Wood — trunks are hand-diggable's one deliberate exception
// (see isHandDiggable), not a special case unto themselves. Only trees
// currently have Wood voxels to chop, but the gate is written generally so
// it isn't a lie if chup ever applies to terrain.
inline bool isChoppable(Material material) {
    return isHandDiggable(material) || material == Material::Wood;
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
