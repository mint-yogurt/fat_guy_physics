#pragma once

#include <optional>

#include <glm/glm.hpp>

namespace fgp {

class World;

// Amanatides & Woo voxel DDA. Stops at the first solid voxel (regardless of
// hardness — hardness only gates removal, not aim, otherwise players could
// "see through" Rock) within maxDistanceMeters of originWorld along
// direction. Returns the hit voxel's integer world coordinate, or nullopt
// if nothing solid is in range.
std::optional<glm::ivec3> raycastVoxel(const World& world, glm::vec3 originWorld, glm::vec3 direction,
                                        float maxDistanceMeters);

} // namespace fgp
