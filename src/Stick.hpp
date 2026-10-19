#pragma once

#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "Inventory.hpp"
#include "Shader.hpp"
#include "voxel/ChunkMesh.hpp"
#include "voxel/TreeVoxels.hpp"

namespace fgp {

// Diameter 1 voxel (X/Z), length 13 (Y) — see buildStickVoxelGrid.
constexpr int kStickLengthVoxels = 13;

// A 1x13x1 Material::Wood grid — local Y is the stick's long axis, spanning
// [0, 1.3m) from the butt (originLocal={0,0,0} puts the butt at local Y=0).
// Vertex-colored only for now (no texture yet, per the request); reused via
// buildTreeVoxelMesh's existing neighbor-culled box-emission pipeline
// rather than hand-rolling a new mesh builder.
TreeVoxelGrid buildStickVoxelGrid();

// Orthonormal basis with `axis` as its Y column (local X/Z perpendicular),
// built from a reference up vector — same "basis from one axis + a
// reference up" construction main.cpp's cubeSnapToQuat already uses for
// snapped logs. Falls back to a world-X reference if axis is parallel to
// referenceUp (degenerate cross product).
glm::mat3 basisFromAxis(glm::vec3 axis, glm::vec3 referenceUp);
glm::quat quatFromAxis(glm::vec3 axis, glm::vec3 referenceUp);

struct StuckStick {
    glm::vec3 position; // butt end, matching the mesh's own local-Y-from-0 pivot
    glm::quat orientation;
};

// Persistent 3D voxel-stick props left behind by a thrown stick that
// embedded in ground/foliage — separate from PickupField (which stays
// 2D-sprite-based for other drops): a stuck stick freezes as a real prop
// at the impact point/orientation rather than becoming a bobbing sprite.
// Owns no GL objects: draw() takes the shared stick ChunkMesh (uploaded
// once in main.cpp's run(), reused for the held view-model, in-flight
// throws, and every stuck stick) by reference and re-poses it per stick
// via uModel — same reuse pattern DynamicLog/PickupField already use for
// their own meshes.
class StuckStickField {
public:
    void spawn(glm::vec3 buttPosition, glm::vec3 axisDirection);

    // Proximity-collects into inventory (tryAdd(ItemType::Stick)) each
    // frame; a full inventory just leaves it where it is, same policy
    // PickupField::update already uses. Call once per frame.
    void update(glm::vec3 playerPos, Inventory& inventory);

    void draw(const Shader& shader, const ChunkMesh& stickMesh) const;

private:
    std::vector<StuckStick> sticks_;
};

} // namespace fgp
