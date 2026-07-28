#include "Camera.hpp"

#include <algorithm>
#include <cmath>

#include <glm/gtc/matrix_transform.hpp>

#include "Player.hpp"
#include "voxel/Voxel.hpp"
#include "voxel/World.hpp"

namespace fgp {

namespace {

constexpr float kThirdPersonCollisionMargin = 0.25f;
constexpr float kThirdPersonSampleStep = 0.05f;
constexpr float kThirdPersonMinDistance = 0.3f;

// Walks a ray in small steps (cheaper than a real raycast to write given how
// short third-person distances are) and returns how far it gets before
// hitting solid terrain, or maxDistance if it doesn't.
float clearDistance(const World& world, glm::vec3 origin, glm::vec3 direction, float maxDistance) {
    for (float t = kThirdPersonSampleStep; t <= maxDistance; t += kThirdPersonSampleStep) {
        const glm::vec3 sample = origin + direction * t;
        const glm::ivec3 voxel(static_cast<int>(std::floor(sample.x / kVoxelSize)),
                                static_cast<int>(std::floor(sample.y / kVoxelSize)),
                                static_cast<int>(std::floor(sample.z / kVoxelSize)));
        if (isSolid(world.materialAt(voxel))) {
            return std::max(0.0f, t - kThirdPersonSampleStep);
        }
    }
    return maxDistance;
}

} // namespace

void Camera::sync(const Player& player, const World& world) {
    const glm::vec3 eye = player.eyePosition();
    // A point in front of the eye, not the eye itself — lookAt needs a
    // non-degenerate eye/target pair, and third-person needs somewhere
    // ahead of the player to actually look at.
    target_ = eye + player.front();
    up_ = player.up();

    if (perspective_ == CameraPerspective::FirstPerson) {
        position_ = eye;
        return;
    }

    const glm::vec3 backward = -player.front();
    const float clear = clearDistance(world, eye, backward, thirdPersonDistance);
    const float distance = std::max(kThirdPersonMinDistance, clear - kThirdPersonCollisionMargin);
    position_ = eye + backward * distance;
}

glm::mat4 Camera::viewMatrix() const {
    return glm::lookAt(position_, target_, up_);
}

} // namespace fgp
