#include "SceneRaycast.hpp"

#include "Voxel.hpp"
#include "VoxelRaycast.hpp"
#include "World.hpp"

namespace fgp {

std::optional<SceneHit> raycastScene(World& world, glm::vec3 originWorld, glm::vec3 direction,
                                      float maxDistanceMeters) {
    std::optional<SceneHit> best;
    float bestDistance = maxDistanceMeters;

    if (const auto terrainVoxel = raycastVoxel(world, originWorld, direction, maxDistanceMeters)) {
        const glm::vec3 hitCenter = (glm::vec3(*terrainVoxel) + 0.5f) * kVoxelSize;
        bestDistance = glm::distance(originWorld, hitCenter);
        best = SceneHit{TerrainHit{*terrainVoxel}};
    }

    for (TreeInstance* tree : world.treesNear(originWorld, maxDistanceMeters)) {
        const auto localVoxel = raycastTree(*tree, originWorld, direction, maxDistanceMeters);
        if (!localVoxel) {
            continue;
        }
        const glm::vec3 hitCenter = tree->rootWorld + (glm::vec3(*localVoxel) + 0.5f) * kVoxelSize;
        const float distance = glm::distance(originWorld, hitCenter);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = SceneHit{TreeHit{tree, *localVoxel}};
        }
    }

    return best;
}

} // namespace fgp
