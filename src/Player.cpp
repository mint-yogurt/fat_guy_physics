#include "Player.hpp"

#include <algorithm>
#include <cmath>

#include <glm/gtc/matrix_transform.hpp>

#include "voxel/Collision.hpp"
#include "voxel/Voxel.hpp"
#include "voxel/World.hpp"

namespace fgp {

namespace {
constexpr float kGravity = -18.0f;
constexpr float kGroundAccel = 30.0f;
constexpr float kAirAccel = 8.0f;
constexpr float kStepHeight = 0.51f; // a hair over 5 voxels
// Rolling friction: horizontal ragball speed decays at this rate (1/s)
// while grounded, so the ball coasts down slopes but settles on flat
// ground instead of sliding forever. Walking has no equivalent — ground
// acceleration doubles as its stopping force (see updateWalking).
constexpr float kRagballGroundFriction = 2.0f;
} // namespace

Player::Player(glm::vec3 feetPosition) : position_(feetPosition) {
    updateVectors();
}

void Player::toggleMode(const World& world) {
    const PlayerMode newMode = mode_ == PlayerMode::Walking ? PlayerMode::Ragball : PlayerMode::Walking;

    if (newMode == PlayerMode::Walking) {
        constexpr float kUnstuckStep = 0.05f;
        constexpr float kMaxUnstuckLift = 2.5f;
        for (float lift = 0.0f; lift <= kMaxUnstuckLift; lift += kUnstuckStep) {
            const glm::vec3 candidate = position_ + glm::vec3(0.0f, lift, 0.0f);
            const glm::vec3 minC = candidate - glm::vec3(kWalkHalfWidth, 0.0f, kWalkHalfWidth);
            const glm::vec3 maxC = candidate + glm::vec3(kWalkHalfWidth, kWalkHeight, kWalkHalfWidth);
            if (!aabbOverlapsSolid(world, minC, maxC)) {
                position_ = candidate;
                break;
            }
        }
    }

    mode_ = newMode;
}

void Player::look(float xOffset, float yOffset) {
    yaw_ += xOffset * mouseSensitivity;
    pitch_ += yOffset * mouseSensitivity;
    pitch_ = std::clamp(pitch_, -89.0f, 89.0f);
    updateVectors();
}

void Player::updateVectors() {
    const float yawRad = glm::radians(yaw_);
    const float pitchRad = glm::radians(pitch_);

    glm::vec3 direction;
    direction.x = std::cos(yawRad) * std::cos(pitchRad);
    direction.y = std::sin(pitchRad);
    direction.z = std::sin(yawRad) * std::cos(pitchRad);
    front_ = glm::normalize(direction);
    right_ = glm::normalize(glm::cross(front_, worldUp_));
    up_ = glm::normalize(glm::cross(right_, front_));
}

glm::vec3 Player::eyePosition() const {
    const float eyeHeight = mode_ == PlayerMode::Walking ? kWalkEyeHeight : kRagballRadius * 1.3f;
    return position_ + glm::vec3(0.0f, eyeHeight, 0.0f);
}

float Player::bodyRadius() const {
    return mode_ == PlayerMode::Walking ? kWalkHalfWidth : kRagballRadius;
}

glm::vec3 Player::bodyCenter() const {
    return position_ + glm::vec3(0.0f, bodyRadius(), 0.0f);
}

void Player::update(const PlayerInput& input, float dt, const World& world) {
    if (mode_ == PlayerMode::Walking) {
        updateWalking(input, dt, world);
    } else {
        updateRagball(input, dt, world);
    }

    updateBodyOrientation(dt);
    respawnIfBelowKillPlane(world);
}

void Player::updateWalking(const PlayerInput& input, float dt, const World& world) {
    const glm::vec3 flatFront = glm::normalize(glm::vec3(front_.x, 0.0f, front_.z));
    const glm::vec3 flatRight = glm::normalize(glm::vec3(right_.x, 0.0f, right_.z));
    const glm::vec3 wishDir = flatFront * input.moveAxis.y + flatRight * input.moveAxis.x;
    const glm::vec3 wishVel =
        (glm::length(wishDir) > 1e-5f ? glm::normalize(wishDir) : glm::vec3(0.0f)) * walkSpeed;

    glm::vec3 horizVel(velocity_.x, 0.0f, velocity_.z);
    const glm::vec3 delta = wishVel - horizVel;
    const float deltaLen = glm::length(delta);
    const float maxChange = (grounded_ ? kGroundAccel : kAirAccel) * dt;
    horizVel += deltaLen <= maxChange || deltaLen < 1e-5f ? delta : delta / deltaLen * maxChange;
    velocity_.x = horizVel.x;
    velocity_.z = horizVel.z;

    velocity_.y += kGravity * dt;
    if (input.jumpPressed && grounded_) {
        velocity_.y = jumpSpeed;
    }

    const AabbCollision result = sweepAabb(world, position_, kWalkHalfWidth, kWalkHeight, velocity_, dt, kStepHeight);
    position_ = result.position;
    velocity_ = result.velocity;
    grounded_ = result.grounded;
}

void Player::updateRagball(const PlayerInput& input, float dt, const World& world) {
    const glm::vec3 flatFront = glm::normalize(glm::vec3(front_.x, 0.0f, front_.z));
    const glm::vec3 flatRight = glm::normalize(glm::vec3(right_.x, 0.0f, right_.z));
    const glm::vec3 wishDir = flatFront * input.moveAxis.y + flatRight * input.moveAxis.x;

    if (glm::length(wishDir) > 1e-5f) {
        velocity_ += glm::normalize(wishDir) * ragballAccel * dt;
    }

    if (grounded_) {
        const float decay = std::exp(-kRagballGroundFriction * dt);
        velocity_.x *= decay;
        velocity_.z *= decay;
    }

    glm::vec3 horiz(velocity_.x, 0.0f, velocity_.z);
    const float speed = glm::length(horiz);
    if (speed > ragballMaxSpeed) {
        horiz = horiz / speed * ragballMaxSpeed;
        velocity_.x = horiz.x;
        velocity_.z = horiz.z;
    }

    velocity_.y += kGravity * dt;

    const glm::vec3 center = position_ + glm::vec3(0.0f, kRagballRadius, 0.0f);
    const SphereCollision result = sweepSphere(world, center, kRagballRadius, velocity_, dt);
    position_ = result.position - glm::vec3(0.0f, kRagballRadius, 0.0f);
    velocity_ = result.velocity;
    grounded_ = result.grounded;
}

void Player::updateBodyOrientation(float dt) {
    const glm::vec3 horizVel(velocity_.x, 0.0f, velocity_.z);
    const float speed = glm::length(horizVel);
    if (speed < 1e-4f) {
        return;
    }

    // Rolling without slipping: the ball rotates about the axis
    // perpendicular to both "up" and its direction of travel, by an angle
    // equal to arc length (speed * dt) over radius.
    const glm::vec3 axis = glm::normalize(glm::cross(glm::vec3(0.0f, 1.0f, 0.0f), horizVel));
    const float angle = speed * dt / bodyRadius();
    orientation_ = glm::angleAxis(angle, axis) * orientation_;
}

void Player::respawnIfBelowKillPlane(const World& world) {
    if (position_.y >= kKillPlaneY) {
        return;
    }

    const int surfaceVoxels = world.surfaceHeightVoxels(0, 0);
    position_ = glm::vec3(0.0f, static_cast<float>(surfaceVoxels) * kVoxelSize + 1.0f, 0.0f);
    velocity_ = glm::vec3(0.0f);
    mode_ = PlayerMode::Walking;
    grounded_ = false;
}

} // namespace fgp
