#include "ItemPickup.hpp"

#include <cmath>
#include <cstddef>

#include <glad/gl.h>

#include "voxel/Voxel.hpp"

namespace fgp {

namespace {
// User-specified sprite widths, in voxels — leaves are small flecks, sticks
// a bit chunkier. Log has no world pickup yet (milestone 7 stretch; logs
// become inventory items straight from a settled physics body), sized here
// only so the switch below stays exhaustive under -Wswitch.
constexpr float kLeafSizeVoxels = 2.0f;
constexpr float kStickSizeVoxels = 3.0f;
constexpr float kLogSizeVoxels = 4.0f;

float pickupSizeMeters(ItemType type) {
    switch (type) {
        case ItemType::Leaf:
            return kLeafSizeVoxels * kVoxelSize;
        case ItemType::Stick:
            return kStickSizeVoxels * kVoxelSize;
        case ItemType::Log:
            return kLogSizeVoxels * kVoxelSize;
    }
    return kLeafSizeVoxels * kVoxelSize;
}

constexpr float kPickupRadiusMeters = 0.7f;
constexpr float kBobSpeedRadiansPerSecond = 2.5f;
// Peak hover height (bottom edge above ground) once landed — see draw()'s
// 1-cos curve, which ranges from 0 (touching ground) up to this.
constexpr float kHoverHeightMeters = 0.08f;
// Same gravity main.cpp's Debris falls under — a real physics body would be
// overkill for something that just needs to drop and stop.
constexpr float kFallGravity = -9.0f;
} // namespace

void PickupField::spawn(glm::vec3 position, ItemType type, float spawnTime, float groundY) {
    const bool startsLanded = position.y <= groundY;
    if (startsLanded) {
        position.y = groundY; // never render buried even if the spawn point was already at/below ground
    }
    pickups_.push_back(ItemPickup{position, glm::vec3(0.0f), groundY, startsLanded, type, spawnTime});
}

void PickupField::update(float dt, float currentTime, glm::vec3 playerPos, Inventory& inventory) {
    for (auto it = pickups_.begin(); it != pickups_.end();) {
        if (!it->landed) {
            it->velocity.y += kFallGravity * dt;
            it->position += it->velocity * dt;
            if (it->position.y <= it->groundY) {
                it->position.y = it->groundY;
                it->velocity = glm::vec3(0.0f);
                it->landed = true;
                // Restart the bob phase at the landing instant, not the
                // original (pre-fall) spawnTime — otherwise draw()'s sine
                // starts at an arbitrary phase the instant landed flips,
                // popping the sprite up/down by up to kBobAmplitudeMeters.
                it->spawnTime = currentTime;
            }
        }
        // Collectible mid-fall, not just once landed — "scoop foliage
        // directly overhead, it falls into your inventory" rather than
        // needing to wait for it to land first.
        if (glm::distance(playerPos, it->position) <= kPickupRadiusMeters && inventory.tryAdd(it->type)) {
            it = pickups_.erase(it);
        } else {
            ++it;
        }
    }
}

void PickupField::draw(const Shader& shader, const std::array<const Texture*, kItemTypeCount>& itemIcons,
                        glm::vec3 cameraPosition, float currentTime) {
    std::array<std::vector<Vertex>, kItemTypeCount> verticesByType;

    // Normal is forced up rather than each quad's true (camera-facing,
    // constantly changing) normal — same reasoning as Vegetation.cpp's bush
    // billboards: keeps lighting stable instead of flickering as the
    // player circles around a drop.
    const glm::vec3 color(1.0f);
    const glm::vec3 normal(0.0f, 1.0f, 0.0f);

    for (const ItemPickup& pickup : pickups_) {
        // Still falling: render exactly on its fall trajectory, no bob —
        // the hover-bob is a "settled" behavior, applied only once landed.
        // 1-cos so the curve starts at 0 (spawnTime is reset to the landing
        // instant — see update()) instead of jumping straight to the hover
        // height, and dips back to the ground each cycle rather than
        // floating at a constant height.
        const float bobY = pickup.landed ? kHoverHeightMeters * (1.0f - std::cos((currentTime - pickup.spawnTime) *
                                                                                   kBobSpeedRadiansPerSecond))
                                          : 0.0f;
        const glm::vec3 groundPos = pickup.position + glm::vec3(0.0f, bobY, 0.0f);
        const float half = pickupSizeMeters(pickup.type) * 0.5f;
        const glm::vec3 center = groundPos + glm::vec3(0.0f, half, 0.0f);

        // Yaw-only billboard (matches Minecraft-style item drops): face the
        // camera's horizontal bearing, ignore its pitch, so the sprite
        // never tilts as the player looks up/down at it.
        glm::vec3 toCamera = cameraPosition - groundPos;
        toCamera.y = 0.0f;
        const float toCameraLenSq = glm::dot(toCamera, toCamera);
        const glm::vec3 forward = toCameraLenSq > 1e-6f ? toCamera / std::sqrt(toCameraLenSq) : glm::vec3(0.0f, 0.0f, 1.0f);
        const glm::vec3 right = glm::normalize(glm::cross(glm::vec3(0.0f, 1.0f, 0.0f), forward));
        const glm::vec3 up(0.0f, 1.0f, 0.0f);

        const glm::vec3 bl = center - right * half - up * half;
        const glm::vec3 br = center + right * half - up * half;
        const glm::vec3 tr = center + right * half + up * half;
        const glm::vec3 tl = center - right * half + up * half;

        auto& verts = verticesByType[static_cast<std::size_t>(pickup.type)];
        verts.push_back({bl, color, {0.0f, 0.0f}, normal});
        verts.push_back({br, color, {1.0f, 0.0f}, normal});
        verts.push_back({tr, color, {1.0f, 1.0f}, normal});
        verts.push_back({bl, color, {0.0f, 0.0f}, normal});
        verts.push_back({tr, color, {1.0f, 1.0f}, normal});
        verts.push_back({tl, color, {0.0f, 1.0f}, normal});
    }

    // Vertices are already in world space (uModel = identity); each quad is
    // only wound for the camera-facing side, so face culling has to be off
    // the same way Vegetation.cpp's bush crosses need it off.
    shader.setMat4("uModel", glm::mat4(1.0f));
    glDisable(GL_CULL_FACE);
    for (std::size_t i = 0; i < kItemTypeCount; ++i) {
        if (verticesByType[i].empty() || itemIcons[i] == nullptr) {
            continue;
        }
        itemIcons[i]->bind(0);
        meshes_[i].upload(verticesByType[i]);
        meshes_[i].draw();
    }
    glEnable(GL_CULL_FACE);
}

} // namespace fgp
