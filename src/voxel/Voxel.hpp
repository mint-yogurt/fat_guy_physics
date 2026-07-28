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

glm::vec3 materialColor(Material material);

} // namespace fgp
