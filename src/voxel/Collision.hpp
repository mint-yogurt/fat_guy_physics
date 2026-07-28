#pragma once

#include <glm/glm.hpp>

namespace fgp {

class World;

struct AabbCollision {
    glm::vec3 position; // resolved position (bottom-center / feet)
    glm::vec3 velocity; // input velocity with blocked axes zeroed
    bool grounded = false;
};

// Sweeps an axis-aligned box through the world by velocity * dt, resolving
// axis-by-axis (Y first, then X, then Z) so the box never ends up
// penetrating a solid voxel. position is the box's bottom-center (feet);
// halfWidth/height describe a box of size (2*halfWidth, height, 2*halfWidth)
// centered horizontally on position. If horizontal movement is blocked while
// grounded, a single step-up attempt is made up to stepHeight (handles the
// many single-voxel ledges a 10cm heightmap produces without needing a real
// stair-stepping animation).
AabbCollision sweepAabb(const World& world, glm::vec3 position, float halfWidth, float height, glm::vec3 velocity,
                         float dt, float stepHeight);

struct SphereCollision {
    glm::vec3 position; // resolved center
    glm::vec3 velocity;
    bool grounded = false;
};

// Sweeps a sphere through the world by velocity * dt. Movement is applied in
// full, then penetration against nearby solid voxels is resolved iteratively
// (closest-point-on-box push-out), so simultaneous contacts (corners,
// grooves) settle out over a few passes rather than one. The velocity
// component pointing into each contact normal is removed (slide response),
// which is what lets a rolling ball keep momentum along a slope instead of
// stopping dead on contact.
SphereCollision sweepSphere(const World& world, glm::vec3 position, float radius, glm::vec3 velocity, float dt);

// True if any solid voxel overlaps [minCorner, maxCorner]. Unlike the sweep
// functions above (which only ever prevent *new* penetration from motion),
// this checks a box's current resting state — needed when a collider shape
// changes discontinuously (e.g. Ragball's sphere swapping for Walking's
// taller box at the same feet position) and might already be embedded in
// terrain the sweep never had a chance to stop.
bool aabbOverlapsSolid(const World& world, glm::vec3 minCorner, glm::vec3 maxCorner);

} // namespace fgp
