#include "VoxelRaycast.hpp"

#include <cmath>
#include <limits>

#include "Voxel.hpp"
#include "World.hpp"

namespace fgp {

std::optional<glm::ivec3> raycastVoxel(const World& world, glm::vec3 originWorld, glm::vec3 direction,
                                        float maxDistanceMeters) {
    const glm::vec3 dir = glm::length(direction) > 0.0f ? glm::normalize(direction) : glm::vec3(0.0f, 0.0f, -1.0f);

    glm::ivec3 voxel(static_cast<int>(std::floor(originWorld.x / kVoxelSize)),
                      static_cast<int>(std::floor(originWorld.y / kVoxelSize)),
                      static_cast<int>(std::floor(originWorld.z / kVoxelSize)));

    glm::ivec3 step(0);
    glm::vec3 tMax(0.0f);
    glm::vec3 tDelta(0.0f);

    for (int axis = 0; axis < 3; ++axis) {
        if (dir[axis] > 0.0f) {
            step[axis] = 1;
            const float voxelBoundary = static_cast<float>(voxel[axis] + 1) * kVoxelSize;
            tMax[axis] = (voxelBoundary - originWorld[axis]) / dir[axis];
            tDelta[axis] = kVoxelSize / dir[axis];
        } else if (dir[axis] < 0.0f) {
            step[axis] = -1;
            const float voxelBoundary = static_cast<float>(voxel[axis]) * kVoxelSize;
            tMax[axis] = (voxelBoundary - originWorld[axis]) / dir[axis];
            tDelta[axis] = kVoxelSize / -dir[axis];
        } else {
            step[axis] = 0;
            tMax[axis] = std::numeric_limits<float>::infinity();
            tDelta[axis] = std::numeric_limits<float>::infinity();
        }
    }

    float t = 0.0f;
    while (t <= maxDistanceMeters) {
        if (isSolid(world.materialAt(voxel))) {
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

} // namespace fgp
