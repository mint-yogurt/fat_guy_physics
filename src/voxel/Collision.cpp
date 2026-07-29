#include "Collision.hpp"

#include <algorithm>
#include <cmath>
#include <utility>

#include "Voxel.hpp"
#include "World.hpp"

namespace fgp {

namespace {

constexpr float kEpsilon = 1e-4f;

// Sweeps the box [minCorner, maxCorner] along one axis by `delta` (either
// sign), returning the largest movement in the same direction that does not
// push the box into a solid voxel.
float sweepBoxAxis(const World& world, glm::vec3 minCorner, glm::vec3 maxCorner, int axis, float delta) {
    if (delta == 0.0f) {
        return 0.0f;
    }

    glm::vec3 sweptMin = minCorner;
    glm::vec3 sweptMax = maxCorner;
    if (delta > 0.0f) {
        sweptMax[axis] += delta;
    } else {
        sweptMin[axis] += delta;
    }

    const int otherA = (axis + 1) % 3;
    const int otherB = (axis + 2) % 3;

    // Bias the bounds inward by kEpsilon before floor/ceil: a resting position
    // is expected to sit exactly on a voxel boundary (e.g. feet flush on a
    // ground layer's top face), but repeated float accumulation (step-up
    // lifts, gravity integration) drifts it a hair below the true value
    // (6.8f can land as 6.79999589...). Un-biased floor()/ceil() then pulls
    // in one extra voxel layer that's actually behind the box's own edge —
    // for an upward sweep that means the ground the box is standing on gets
    // scanned as if it were a ceiling ahead, via the same formula below,
    // clamping all upward movement (jump, step-up headroom) to 0.
    const glm::ivec3 voxMin(static_cast<int>(std::floor((sweptMin.x + kEpsilon) / kVoxelSize)),
                             static_cast<int>(std::floor((sweptMin.y + kEpsilon) / kVoxelSize)),
                             static_cast<int>(std::floor((sweptMin.z + kEpsilon) / kVoxelSize)));
    const glm::ivec3 voxMax(static_cast<int>(std::ceil((sweptMax.x - kEpsilon) / kVoxelSize)) - 1,
                             static_cast<int>(std::ceil((sweptMax.y - kEpsilon) / kVoxelSize)) - 1,
                             static_cast<int>(std::ceil((sweptMax.z - kEpsilon) / kVoxelSize)) - 1);

    float allowed = delta;

    for (int x = voxMin.x; x <= voxMax.x; ++x) {
        for (int y = voxMin.y; y <= voxMax.y; ++y) {
            for (int z = voxMin.z; z <= voxMax.z; ++z) {
                const glm::ivec3 voxel(x, y, z);
                if (!world.isSolidIncludingSnappedLogs(voxel)) { // see its stopgap comment
                    continue;
                }

                const glm::vec3 voxelMin = glm::vec3(voxel) * kVoxelSize;
                const glm::vec3 voxelMax = voxelMin + glm::vec3(kVoxelSize);

                // Only voxels overlapping the box on both non-swept axes can
                // block movement along this axis.
                if (voxelMax[otherA] <= minCorner[otherA] + kEpsilon ||
                    voxelMin[otherA] >= maxCorner[otherA] - kEpsilon) {
                    continue;
                }
                if (voxelMax[otherB] <= minCorner[otherB] + kEpsilon ||
                    voxelMin[otherB] >= maxCorner[otherB] - kEpsilon) {
                    continue;
                }

                if (delta > 0.0f) {
                    const float maxAllowed = voxelMin[axis] - maxCorner[axis];
                    if (maxAllowed < allowed) {
                        allowed = std::max(0.0f, maxAllowed);
                    }
                } else {
                    const float maxAllowed = voxelMax[axis] - minCorner[axis];
                    if (maxAllowed > allowed) {
                        allowed = std::min(0.0f, maxAllowed);
                    }
                }
            }
        }
    }

    return allowed;
}

} // namespace

AabbCollision sweepAabb(const World& world, glm::vec3 position, float halfWidth, float height, glm::vec3 velocity,
                         float dt, float stepHeight) {
    glm::vec3 pos = position;
    glm::vec3 vel = velocity;

    const auto boxAt = [&](glm::vec3 feet) {
        return std::pair<glm::vec3, glm::vec3>{
            feet - glm::vec3(halfWidth, 0.0f, halfWidth),
            feet + glm::vec3(halfWidth, height, halfWidth),
        };
    };

    // Grounded probe taken BEFORE the Y sweep, purely to gate the step-up
    // assist below. A jump impulse this same call (vel.y = jumpSpeed) can
    // move the box up more than the post-sweep probe distance in a single
    // substep (e.g. 6.3 m/s / 120Hz = 0.0525m > the 0.05m probe), which
    // would make the post-sweep probe read airborne on the very frame you
    // pressed Space — skipping the step-up assist and zeroing vel.x against
    // the ledge instead of lifting you onto it. Whether you were standing
    // on solid ground an instant ago doesn't depend on this frame's jump.
    bool groundedAtEntry = false;
    {
        constexpr float kProbeDistance = 0.05f;
        const auto [minC, maxC] = boxAt(pos);
        const float probe = sweepBoxAxis(world, minC, maxC, 1, -kProbeDistance);
        groundedAtEntry = probe > -kProbeDistance + kEpsilon;
    }

    // Y axis first (gravity / ground) so the horizontal sweeps below see an
    // already-settled height.
    {
        const auto [minC, maxC] = boxAt(pos);
        const float dy = sweepBoxAxis(world, minC, maxC, 1, vel.y * dt);
        pos.y += dy;
        if (std::abs(dy - vel.y * dt) > kEpsilon) {
            vel.y = 0.0f;
        }
    }

    // Grounded probe: can the box fall a little further from here? If not,
    // something is directly underfoot. This is the value callers see
    // (Player's grounded_ for next frame's jump/air-accel decisions).
    bool grounded = false;
    {
        constexpr float kProbeDistance = 0.05f;
        const auto [minC, maxC] = boxAt(pos);
        const float probe = sweepBoxAxis(world, minC, maxC, 1, -kProbeDistance);
        grounded = probe > -kProbeDistance + kEpsilon;
    }

    const float dxRequested = vel.x * dt;
    const float dzRequested = vel.z * dt;

    float dxAllowed;
    {
        const auto [minC, maxC] = boxAt(pos);
        dxAllowed = sweepBoxAxis(world, minC, maxC, 0, dxRequested);
    }

    float dzAllowed;
    {
        const auto [minC, maxC] = boxAt(pos + glm::vec3(dxAllowed, 0.0f, 0.0f));
        dzAllowed = sweepBoxAxis(world, minC, maxC, 2, dzRequested);
    }

    const bool xBlocked = std::abs(dxAllowed - dxRequested) > kEpsilon;
    const bool zBlocked = std::abs(dzAllowed - dzRequested) > kEpsilon;

    // A 10cm heightmap produces lots of single-voxel ledges; without a step
    // assist those would stop a walking player dead at every bump. Try the
    // horizontal move again from progressively higher lifts (starting at
    // exactly one voxel, the common case) rather than only ever attempting
    // the full stepHeight in one go — a single big lift can fail (e.g. a
    // second bump just beyond reach at that height) in cases a smaller,
    // exact-fit lift would have cleared. Commits to (settles down onto) the
    // first lift height that makes progress on every axis that was blocked
    // at ground level, without newly blocking one that wasn't (diagonal
    // approaches have both dx and dz nonzero almost all the time, so
    // requiring *both* to fully clear — rather than just the ones that were
    // actually blocked — made this misfire on anything but a dead-on
    // approach).
    if (groundedAtEntry && stepHeight > 0.0f && (xBlocked || zBlocked)) {
        for (float lift = kVoxelSize; lift <= stepHeight + kEpsilon; lift += kVoxelSize) {
            const auto [baseMinC, baseMaxC] = boxAt(pos);
            const float headroom = sweepBoxAxis(world, baseMinC, baseMaxC, 1, lift);
            if (headroom < lift - kEpsilon) {
                break; // no clearance at this height, and none higher either
            }

            const glm::vec3 liftedPos = pos + glm::vec3(0.0f, lift, 0.0f);
            const auto [liftMinC, liftMaxC] = boxAt(liftedPos);
            const float liftedDx = sweepBoxAxis(world, liftMinC, liftMaxC, 0, dxRequested);

            const glm::vec3 liftedPosAfterX = liftedPos + glm::vec3(liftedDx, 0.0f, 0.0f);
            const auto [liftMinC2, liftMaxC2] = boxAt(liftedPosAfterX);
            const float liftedDz = sweepBoxAxis(world, liftMinC2, liftMaxC2, 2, dzRequested);

            const bool liftedXBlocked = std::abs(liftedDx - dxRequested) > kEpsilon;
            const bool liftedZBlocked = std::abs(liftedDz - dzRequested) > kEpsilon;
            const bool xOkOrImproved = !xBlocked || !liftedXBlocked;
            const bool zOkOrImproved = !zBlocked || !liftedZBlocked;
            if (xOkOrImproved && zOkOrImproved) {
                glm::vec3 settledPos = liftedPosAfterX + glm::vec3(0.0f, 0.0f, liftedDz);
                const auto [settleMinC, settleMaxC] = boxAt(settledPos);
                settledPos.y += sweepBoxAxis(world, settleMinC, settleMaxC, 1, -lift);
                return AabbCollision{settledPos, vel, true};
            }
        }
    }

    pos.x += dxAllowed;
    pos.z += dzAllowed;
    if (xBlocked) vel.x = 0.0f;
    if (zBlocked) vel.z = 0.0f;

    return AabbCollision{pos, vel, grounded};
}

SphereCollision sweepSphere(const World& world, glm::vec3 position, float radius, glm::vec3 velocity, float dt) {
    glm::vec3 pos = position + velocity * dt;
    glm::vec3 vel = velocity;
    bool grounded = false;

    // A handful of penetration-resolution passes lets simultaneous contacts
    // (a corner between two voxel faces, a groove) settle out instead of
    // only ever resolving the single deepest one per frame.
    constexpr int kIterations = 4;
    for (int iter = 0; iter < kIterations; ++iter) {
        // Biased inward by kEpsilon before floor(), same reasoning as
        // sweepBoxAxis's comment above: a resting position sitting exactly
        // on a voxel boundary can drift a hair below it from float
        // accumulation, and an unbiased floor() then pulls in one extra
        // voxel layer that's actually behind the sphere's own edge.
        const glm::ivec3 voxMin(static_cast<int>(std::floor((pos.x - radius + kEpsilon) / kVoxelSize)),
                                 static_cast<int>(std::floor((pos.y - radius + kEpsilon) / kVoxelSize)),
                                 static_cast<int>(std::floor((pos.z - radius + kEpsilon) / kVoxelSize)));
        const glm::ivec3 voxMax(static_cast<int>(std::floor((pos.x + radius - kEpsilon) / kVoxelSize)),
                                 static_cast<int>(std::floor((pos.y + radius - kEpsilon) / kVoxelSize)),
                                 static_cast<int>(std::floor((pos.z + radius - kEpsilon) / kVoxelSize)));

        bool anyPenetration = false;
        for (int x = voxMin.x; x <= voxMax.x; ++x) {
            for (int y = voxMin.y; y <= voxMax.y; ++y) {
                for (int z = voxMin.z; z <= voxMax.z; ++z) {
                    const glm::ivec3 voxel(x, y, z);
                    if (!world.isSolidIncludingSnappedLogs(voxel)) { // see its stopgap comment
                        continue;
                    }

                    const glm::vec3 voxelMin = glm::vec3(voxel) * kVoxelSize;
                    const glm::vec3 voxelMax = voxelMin + glm::vec3(kVoxelSize);
                    const glm::vec3 closest = glm::clamp(pos, voxelMin, voxelMax);
                    const glm::vec3 toCenter = pos - closest;
                    const float dist = glm::length(toCenter);
                    if (dist >= radius || dist < 1e-6f) {
                        continue;
                    }

                    const glm::vec3 normal = toCenter / dist;
                    const float penetration = radius - dist;
                    pos += normal * penetration;

                    // Slide response: drop only the velocity component
                    // pointing into the surface so a rolling ball keeps
                    // momentum along the tangent (e.g. down a slope).
                    const float intoSurface = glm::dot(vel, normal);
                    if (intoSurface < 0.0f) {
                        vel -= normal * intoSurface;
                    }
                    if (normal.y > 0.5f) {
                        grounded = true;
                    }
                    anyPenetration = true;
                }
            }
        }

        if (!anyPenetration) {
            break;
        }
    }

    return SphereCollision{pos, vel, grounded};
}

bool aabbOverlapsSolid(const World& world, glm::vec3 minCorner, glm::vec3 maxCorner) {
    // Biased inward by kEpsilon before floor/ceil, same reasoning as
    // sweepBoxAxis's comment above.
    const glm::ivec3 voxMin(static_cast<int>(std::floor((minCorner.x + kEpsilon) / kVoxelSize)),
                             static_cast<int>(std::floor((minCorner.y + kEpsilon) / kVoxelSize)),
                             static_cast<int>(std::floor((minCorner.z + kEpsilon) / kVoxelSize)));
    const glm::ivec3 voxMax(static_cast<int>(std::ceil((maxCorner.x - kEpsilon) / kVoxelSize)) - 1,
                             static_cast<int>(std::ceil((maxCorner.y - kEpsilon) / kVoxelSize)) - 1,
                             static_cast<int>(std::ceil((maxCorner.z - kEpsilon) / kVoxelSize)) - 1);

    for (int x = voxMin.x; x <= voxMax.x; ++x) {
        for (int y = voxMin.y; y <= voxMax.y; ++y) {
            for (int z = voxMin.z; z <= voxMax.z; ++z) {
                if (world.isSolidIncludingSnappedLogs(glm::ivec3(x, y, z))) { // see its stopgap comment
                    return true;
                }
            }
        }
    }
    return false;
}

} // namespace fgp
