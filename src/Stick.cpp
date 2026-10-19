#include "Stick.hpp"

#include <glm/gtc/matrix_transform.hpp>

namespace fgp {

namespace {
constexpr float kStuckStickPickupRadiusMeters = 0.7f; // matches PickupField's own kPickupRadiusMeters
} // namespace

TreeVoxelGrid buildStickVoxelGrid() {
    TreeVoxelGrid grid;
    grid.dims = {1, kStickLengthVoxels, 1};
    grid.originLocal = {0, 0, 0};
    grid.cells.assign(static_cast<std::size_t>(kStickLengthVoxels), Material::Wood);
    return grid;
}

glm::mat3 basisFromAxis(glm::vec3 axis, glm::vec3 referenceUp) {
    glm::vec3 x = glm::cross(referenceUp, axis);
    if (glm::dot(x, x) < 1e-6f) {
        x = glm::cross(glm::vec3(1.0f, 0.0f, 0.0f), axis);
    }
    x = glm::normalize(x);
    const glm::vec3 z = glm::cross(x, axis);
    return glm::mat3(x, axis, z); // columns: local X, stick axis (Y), local Z
}

glm::quat quatFromAxis(glm::vec3 axis, glm::vec3 referenceUp) {
    return glm::quat_cast(basisFromAxis(axis, referenceUp));
}

void StuckStickField::spawn(glm::vec3 buttPosition, glm::vec3 axisDirection) {
    sticks_.push_back(StuckStick{buttPosition, quatFromAxis(axisDirection, glm::vec3(0.0f, 1.0f, 0.0f))});
}

void StuckStickField::update(glm::vec3 playerPos, Inventory& inventory) {
    for (auto it = sticks_.begin(); it != sticks_.end();) {
        if (glm::distance(playerPos, it->position) <= kStuckStickPickupRadiusMeters &&
            inventory.tryAdd(ItemType::Stick)) {
            it = sticks_.erase(it);
        } else {
            ++it;
        }
    }
}

void StuckStickField::draw(const Shader& shader, const ChunkMesh& stickMesh) const {
    for (const StuckStick& s : sticks_) {
        shader.setMat4("uModel", glm::translate(glm::mat4(1.0f), s.position) * glm::mat4_cast(s.orientation));
        stickMesh.draw();
    }
}

} // namespace fgp
