#pragma once

#include <array>
#include <vector>

#include <glm/glm.hpp>

#include "Inventory.hpp"
#include "Shader.hpp"
#include "Texture.hpp"
#include "voxel/ChunkMesh.hpp"

namespace fgp {

// A dropped item. Falls under gravity (simple kinematic integration, same
// "stub, not real physics" style as main.cpp's Debris) from its spawn point
// down to groundY, then switches to a scripted hover-bob in place — see
// PickupField::update.
struct ItemPickup {
    glm::vec3 position;
    glm::vec3 velocity;
    float groundY; // world Y of the terrain surface directly below spawn — precomputed once, not re-queried per frame
    bool landed = false;
    ItemType type;
    float spawnTime;
};

// World-space item drops from scoop/chup (see main.cpp): spawn at the
// scoop/chup point, fall to the ground, then hover-bob in place until
// auto-collected into an Inventory on proximity (falling items are still
// collectible mid-fall, not just once landed — see update). Rendered as a
// billboard that only rotates around Y to face the camera (main.cpp's
// cameraPosition), reusing the same PNGs already loaded for the hotbar
// icons as the sprite texture.
class PickupField {
public:
    // groundY: world Y of the terrain surface directly below position,
    // i.e. where the fall stops — main.cpp computes this once via a
    // downward raycast at spawn time rather than every frame.
    void spawn(glm::vec3 position, ItemType type, float spawnTime, float groundY);

    // Integrates gravity for any still-falling pickup, then collects any
    // pickup within pickup range of playerPos into inventory (removing
    // it); a full inventory just leaves it where it is. currentTime resets
    // a pickup's bob phase the instant it lands (see update()'s comment on
    // why). Call once per frame, not per physics substep.
    void update(float dt, float currentTime, glm::vec3 playerPos, Inventory& inventory);

    // itemIcons is the same array Hotbar::draw takes (indexed by ItemType);
    // a nullptr entry silently skips drawing that type. currentTime drives
    // the per-pickup bob offset from its spawnTime (bob only applies once
    // landed — a falling item just falls, no bob).
    void draw(const Shader& shader, const std::array<const Texture*, kItemTypeCount>& itemIcons,
              glm::vec3 cameraPosition, float currentTime);

private:
    std::vector<ItemPickup> pickups_;
    // One dynamic mesh per item type, rebuilt every draw() call since
    // billboard orientation/bob height changes every frame — see
    // ChunkMesh::upload's doc comment on why re-upload-in-place is cheap
    // enough for this (same pattern trees use on edit).
    std::array<ChunkMesh, kItemTypeCount> meshes_;
};

} // namespace fgp
