#pragma once

#include <optional>
#include <variant>

#include <glm/glm.hpp>

#include "TreeVoxels.hpp"

namespace fgp {

class World;

struct TerrainHit {
    glm::ivec3 voxel; // world voxel coordinate
};

struct TreeHit {
    TreeInstance* tree;      // valid until World::update() next runs (can unload the owning chunk)
    glm::ivec3 localVoxel;   // tree-local voxel coordinate (see TreeVoxelGrid's origin convention)
};

// TEMPORARY, BAD DESIGN — do not extend this pattern further, and plan to
// replace it. This variant enumerates only what a raycast is currently
// capable of hitting; every new hittable object type (this went from 2
// members to 3 with LogHit in main.cpp's ActionHit, and will keep growing —
// props, other players, whatever comes next) means finding and updating
// every call site that switches on the variant, by hand, with the compiler
// giving no help if one is missed or narrowed incorrectly. That's not
// hypothetical: main.cpp's chup handler shipped with exactly that bug —
// a branch written as "if not a tree, must be a log" that silently assumed
// away the terrain case once this variant grew a third member, and
// null-pointer-crashed the instant a chup swing landed on plain ground.
// The right shape is a raycast that always conceptually resolves to
// *something* in range (including "nothing solid," including materials
// too hard to act on) via one uniform result — material/position/whatever
// identifies the owning object — with the type system not in the business
// of enumerating "here is the closed set of things you're allowed to hit."
// Callers then decide what's actionable (Air/too-hard = no-op) instead of
// the raycast API deciding it for them via which variant arms exist.
using SceneHit = std::variant<TerrainHit, TreeHit>;

// Combines VoxelRaycast's terrain raycast with a tree-local raycast against
// every tree World::treesNear finds within reach, keeping whichever hit is
// nearer. Trees are invisible to raycastVoxel alone (they were never part
// of World's voxel grid — see TreeVoxels.hpp) so scoop/chup both need this
// instead of the terrain-only raycast.
std::optional<SceneHit> raycastScene(World& world, glm::vec3 originWorld, glm::vec3 direction,
                                      float maxDistanceMeters);

} // namespace fgp
