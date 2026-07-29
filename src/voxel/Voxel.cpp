#include "Voxel.hpp"

namespace fgp {

glm::vec3 materialColor(Material material) {
    // Flat placeholder colors (vertex-colored, no textures yet per
    // DESIGN.md's low-texture-memory goal). Tuned for visual distinction,
    // not accuracy.
    switch (material) {
        case Material::Air:     return glm::vec3(0.0f);
        case Material::Sand:    return glm::vec3(0.86f, 0.78f, 0.53f);
        case Material::Snow:    return glm::vec3(0.95f, 0.95f, 0.97f);
        case Material::Dirt:    return glm::vec3(0.45f, 0.32f, 0.20f);
        case Material::Clay:    return glm::vec3(0.62f, 0.42f, 0.35f);
        case Material::Gravel:  return glm::vec3(0.55f, 0.55f, 0.55f);
        case Material::Rock:    return glm::vec3(0.40f, 0.40f, 0.42f);
        case Material::Granite: return glm::vec3(0.60f, 0.50f, 0.48f);
        case Material::Ice:     return glm::vec3(0.75f, 0.90f, 0.95f);
        case Material::Wood:    return glm::vec3(0.36f, 0.24f, 0.15f); // matches Vegetation.cpp's old kTrunkBaseColor
        case Material::Leaf:    return glm::vec3(0.25f, 0.48f, 0.17f); // matches Vegetation.cpp's old kFoliageBaseColor
    }
    return glm::vec3(1.0f, 0.0f, 1.0f); // unmapped material: hot pink
}

} // namespace fgp
