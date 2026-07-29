#pragma once

#include <memory>
#include <unordered_map>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

// Jolt.h must precede any other Jolt header (it sets up the namespace
// macros/allocation overrides every other header relies on).
#include <Jolt/Jolt.h>
#include <Jolt/Physics/Body/BodyID.h>

#include "../voxel/Chunk.hpp"

namespace fgp {

class World;

// Thin wrapper around a JPH::PhysicsSystem: gravity-driven dynamic bodies
// (falling logs, debug props) colliding with the existing voxel terrain.
// Player-vs-terrain movement stays on voxel/Collision.hpp's tuned sweep
// functions, entirely unconverted — this is additive for new dynamic
// objects only (see DESIGN.md/plan notes on why).
//
// Terrain collision uses one static JPH::MeshShape body per loaded chunk,
// built from the same triangle data World's greedy mesher already produces
// (World::chunkMeshVertices), created/kept only for chunks within
// kChunkBodyRadius of the position passed to syncChunkBodies (there are
// hundreds of loaded chunks streamed in at once; only the handful near any
// dynamic object need a physics body). A JPH::HeightFieldShape was
// considered and rejected: World::digSphere can carve overhangs/tunnels a
// one-height-per-column heightfield can't represent.
class PhysicsWorld {
public:
    explicit PhysicsWorld(World& voxelWorld);
    ~PhysicsWorld();

    PhysicsWorld(const PhysicsWorld&) = delete;
    PhysicsWorld& operator=(const PhysicsWorld&) = delete;

    // Advances the simulation by one fixed substep. Call once per
    // kFixedTimestep tick, alongside Player::update.
    void step(float fixedDt);

    // Creates/removes static per-chunk terrain bodies so only chunks near
    // worldPos (roughly kChunkBodyRadius chunks out) carry a physics body,
    // and rebuilds the shape for any chunk World reports as edited since
    // the last call. Call once per frame, before the fixed-substep loop, so
    // newly streamed-in terrain has a body before anything can fall into it.
    void syncChunkBodies(glm::vec3 worldPos);

    // Spawns a dynamic capsule body (radius/halfHeight in meters) at
    // position/orientation, with wood-density mass. applyToppleImpulse
    // adds a small initial angular impulse so a piece freshly cut from a
    // standing (vertical) trunk topples rather than balancing on its flat
    // cut face — that degenerate equilibrium doesn't recur when re-cutting
    // an already-fallen (non-vertical) log, so callers there should pass
    // false rather than giving an already-resting piece an unwanted kick.
    // Returns an invalid BodyID (check IsInvalid()) if body creation
    // failed (e.g. body limit reached).
    JPH::BodyID spawnCapsuleBody(glm::vec3 position, glm::quat orientation, float radius, float halfHeight,
                                  bool applyToppleImpulse);

    // Debug-only convenience for the milestone-1 falling-box demo: a
    // dynamic unit-density box.
    JPH::BodyID spawnDebugBoxBody(glm::vec3 position, glm::vec3 halfExtents);

    void removeBody(JPH::BodyID id);

    glm::mat4 bodyTransform(JPH::BodyID id) const;
    bool bodyIsActive(JPH::BodyID id) const;

    // Teleports a body to an exact position/rotation without waking it —
    // used by main.cpp's snap-on-sleep machinery to commit a felled log's
    // rest pose onto the axis-aligned voxel lattice once it's asleep. Not a
    // general-purpose setter: calling this on an active body is fine
    // physically (Jolt just relocates it) but pointless for anything this
    // codebase currently does with it.
    void setBodyTransform(JPH::BodyID id, glm::vec3 position, glm::quat rotation);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;

    World& voxelWorld_;
    std::unordered_map<ChunkCoord, JPH::BodyID, ChunkCoordHash> chunkBodies_;

    void addOrRefreshChunkBody(ChunkCoord coord);
    void removeChunkBody(ChunkCoord coord);
};

} // namespace fgp
