#include "PhysicsWorld.hpp"

#include <cmath>
#include <cstdarg>
#include <cstdio>
#include <thread>

#include <Jolt/Core/Factory.h>
#include <Jolt/Core/JobSystemThreadPool.h>
#include <Jolt/Core/TempAllocator.h>
#include <Jolt/Math/Math.h>
#include <Jolt/Physics/Body/BodyCreationSettings.h>
#include <Jolt/Physics/Body/BodyInterface.h>
#include <Jolt/Physics/Collision/BroadPhase/BroadPhaseLayer.h>
#include <Jolt/Physics/Collision/ObjectLayer.h>
#include <Jolt/Physics/Collision/Shape/BoxShape.h>
#include <Jolt/Physics/Collision/Shape/CapsuleShape.h>
#include <Jolt/Physics/Collision/Shape/MeshShape.h>
#include <Jolt/Physics/PhysicsSettings.h>
#include <Jolt/Physics/PhysicsSystem.h>
#include <Jolt/RegisterTypes.h>

#include <glm/gtc/matrix_transform.hpp>

#include "../voxel/ChunkMesher.hpp"
#include "../voxel/Voxel.hpp"
#include "../voxel/World.hpp"

namespace fgp {

namespace {

// Static terrain (chunk MeshShape bodies) vs. everything that falls/rolls
// (debug boxes, severed logs). Two layers is the minimum useful split per
// Jolt's own docs — non-moving bodies never need to collide with each
// other, so keeping them out of the same broadphase tree avoids updating a
// tree full of static geometry every frame.
namespace Layers {
constexpr JPH::ObjectLayer kNonMoving = 0;
constexpr JPH::ObjectLayer kMoving = 1;
constexpr JPH::uint kNumLayers = 2;
} // namespace Layers

namespace BroadPhaseLayers {
constexpr JPH::BroadPhaseLayer kNonMoving(0);
constexpr JPH::BroadPhaseLayer kMoving(1);
constexpr JPH::uint kNumLayers = 2;
} // namespace BroadPhaseLayers

class ObjectLayerPairFilterImpl final : public JPH::ObjectLayerPairFilter {
public:
    bool ShouldCollide(JPH::ObjectLayer object1, JPH::ObjectLayer object2) const override {
        if (object1 == Layers::kNonMoving) {
            return object2 == Layers::kMoving;
        }
        return true;
    }
};

class BPLayerInterfaceImpl final : public JPH::BroadPhaseLayerInterface {
public:
    BPLayerInterfaceImpl() {
        objectToBroadPhase_[Layers::kNonMoving] = BroadPhaseLayers::kNonMoving;
        objectToBroadPhase_[Layers::kMoving] = BroadPhaseLayers::kMoving;
    }

    JPH::uint GetNumBroadPhaseLayers() const override { return BroadPhaseLayers::kNumLayers; }

    JPH::BroadPhaseLayer GetBroadPhaseLayer(JPH::ObjectLayer layer) const override {
        return objectToBroadPhase_[layer];
    }

#if defined(JPH_EXTERNAL_PROFILE) || defined(JPH_PROFILE_ENABLED)
    // Only pure virtual (and thus only required) when Jolt's profiler is
    // compiled in — true for Debug builds, not this project's default
    // RelWithDebInfo, so this must stay conditional to compile either way.
    const char* GetBroadPhaseLayerName(JPH::BroadPhaseLayer layer) const override {
        switch (static_cast<JPH::BroadPhaseLayer::Type>(layer)) {
            case static_cast<JPH::BroadPhaseLayer::Type>(BroadPhaseLayers::kNonMoving):
                return "NON_MOVING";
            case static_cast<JPH::BroadPhaseLayer::Type>(BroadPhaseLayers::kMoving):
                return "MOVING";
            default:
                return "INVALID";
        }
    }
#endif

private:
    JPH::BroadPhaseLayer objectToBroadPhase_[Layers::kNumLayers];
};

class ObjectVsBroadPhaseLayerFilterImpl final : public JPH::ObjectVsBroadPhaseLayerFilter {
public:
    bool ShouldCollide(JPH::ObjectLayer layer1, JPH::BroadPhaseLayer layer2) const override {
        if (layer1 == Layers::kNonMoving) {
            return layer2 == BroadPhaseLayers::kMoving;
        }
        return true;
    }
};

void traceImpl(const char* fmt, ...) {
    va_list list;
    va_start(list, fmt);
    char buffer[1024];
    std::vsnprintf(buffer, sizeof(buffer), fmt, list);
    va_end(list);
    std::fprintf(stderr, "[Jolt] %s\n", buffer);
}

#ifdef JPH_ENABLE_ASSERTS
bool assertFailedImpl(const char* expression, const char* message, const char* file, JPH::uint line) {
    std::fprintf(stderr, "[Jolt] %s:%u: (%s) %s\n", file, line, expression, message ? message : "");
    return true; // breakpoint
}
#endif

// Density used to derive falling-log mass (green/wet hardwood is
// ~700-900 kg/m^3; this is a representative ballpark, not a per-species
// lookup).
constexpr float kWoodDensityKgPerM3 = 700.0f;

constexpr float kMaxBodyPairsAndConstraints = 4096;

JPH::RVec3 toJph(glm::vec3 v) { return JPH::RVec3(v.x, v.y, v.z); }
JPH::Quat toJph(glm::quat q) { return JPH::Quat(q.x, q.y, q.z, q.w); }
glm::vec3 toGlm(JPH::RVec3Arg v) { return glm::vec3(v.GetX(), v.GetY(), v.GetZ()); }
glm::quat toGlm(JPH::QuatArg q) { return glm::quat(q.GetW(), q.GetX(), q.GetY(), q.GetZ()); }

// Builds a static JPH::MeshShape from a chunk's greedy-meshed triangle
// list (already chunk-local meters, non-indexed — see
// World::chunkMeshVertices). Returns nullptr for an empty chunk (all-air;
// MeshShapeSettings::Create() rejects zero triangles) since there's
// nothing to collide with anyway.
JPH::RefConst<JPH::Shape> buildChunkShape(const std::vector<Vertex>& vertices) {
    if (vertices.empty()) {
        return nullptr;
    }

    JPH::TriangleList triangles;
    triangles.reserve(vertices.size() / 3);
    for (std::size_t i = 0; i + 2 < vertices.size(); i += 3) {
        const glm::vec3& a = vertices[i].position;
        const glm::vec3& b = vertices[i + 1].position;
        const glm::vec3& c = vertices[i + 2].position;
        triangles.push_back(JPH::Triangle(JPH::Float3(a.x, a.y, a.z), JPH::Float3(b.x, b.y, b.z),
                                           JPH::Float3(c.x, c.y, c.z)));
    }

    JPH::MeshShapeSettings settings(triangles);
    const JPH::ShapeSettings::ShapeResult result = settings.Create();
    if (result.HasError()) {
        std::fprintf(stderr, "[Jolt] chunk MeshShape build failed: %s\n", result.GetError().c_str());
        return nullptr;
    }
    return result.Get();
}

} // namespace

struct PhysicsWorld::Impl {
    BPLayerInterfaceImpl broadPhaseLayerInterface;
    ObjectVsBroadPhaseLayerFilterImpl objectVsBroadPhaseLayerFilter;
    ObjectLayerPairFilterImpl objectVsObjectLayerFilter;
    JPH::PhysicsSystem physicsSystem;
    JPH::TempAllocatorImpl tempAllocator{10 * 1024 * 1024};
    JPH::JobSystemThreadPool jobSystem{JPH::cMaxPhysicsJobs, JPH::cMaxPhysicsBarriers,
                                        static_cast<int>(std::thread::hardware_concurrency()) - 1};
};

namespace {
// Jolt's Factory/RegisterTypes are one-time, process-global setup with no
// instance to hang them off — PhysicsWorld is only ever constructed once
// for the process's lifetime (main.cpp owns a single instance), so tying
// this to its ctor/dtor is equivalent to doing it in main() but keeps all
// Jolt bootstrapping in one file.
void ensureJoltRegistered() {
    static bool registered = false;
    if (registered) {
        return;
    }
    JPH::RegisterDefaultAllocator();
    JPH::Trace = traceImpl;
    JPH_IF_ENABLE_ASSERTS(JPH::AssertFailed = assertFailedImpl;)
    JPH::Factory::sInstance = new JPH::Factory();
    JPH::RegisterTypes();
    registered = true;
}
} // namespace

PhysicsWorld::PhysicsWorld(World& voxelWorld) : voxelWorld_(voxelWorld) {
    ensureJoltRegistered();

    impl_ = std::make_unique<Impl>();
    constexpr JPH::uint kMaxBodies = 8192;
    constexpr JPH::uint kNumBodyMutexes = 0; // default
    impl_->physicsSystem.Init(kMaxBodies, kNumBodyMutexes, kMaxBodyPairsAndConstraints, kMaxBodyPairsAndConstraints,
                               impl_->broadPhaseLayerInterface, impl_->objectVsBroadPhaseLayerFilter,
                               impl_->objectVsObjectLayerFilter);
    impl_->physicsSystem.SetGravity(JPH::Vec3(0.0f, -18.0f, 0.0f)); // matches Player.cpp's kGravity
}

PhysicsWorld::~PhysicsWorld() = default;

void PhysicsWorld::step(float fixedDt) {
    impl_->physicsSystem.Update(fixedDt, /*collisionSteps=*/1, &impl_->tempAllocator, &impl_->jobSystem);
}

namespace {
// On-demand terrain body radius: loaded chunks (World's own load radius)
// number in the hundreds, but only ones near something that can actually
// fall need a collision shape. Tunable — widen if fast-moving dynamic
// bodies start tunneling through terrain that streamed a body in too late.
constexpr int kChunkBodyRadius = 2;
} // namespace

void PhysicsWorld::addOrRefreshChunkBody(ChunkCoord coord) {
    const std::vector<Vertex>* vertices = voxelWorld_.chunkMeshVertices(coord);
    if (vertices == nullptr) {
        return;
    }
    JPH::RefConst<JPH::Shape> shape = buildChunkShape(*vertices);
    if (!shape) {
        return; // empty chunk, nothing to collide with
    }

    JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
    const glm::vec3 worldOrigin = glm::vec3(coord) * (static_cast<float>(kChunkSize) * kVoxelSize);

    const auto it = chunkBodies_.find(coord);
    if (it != chunkBodies_.end()) {
        bodyInterface.SetShape(it->second, shape, /*updateMassProperties=*/false, JPH::EActivation::DontActivate);
        return;
    }

    JPH::BodyCreationSettings settings(shape, toJph(worldOrigin), JPH::Quat::sIdentity(), JPH::EMotionType::Static,
                                        Layers::kNonMoving);
    const JPH::BodyID id = bodyInterface.CreateAndAddBody(settings, JPH::EActivation::DontActivate);
    chunkBodies_[coord] = id;
}

void PhysicsWorld::removeChunkBody(ChunkCoord coord) {
    const auto it = chunkBodies_.find(coord);
    if (it == chunkBodies_.end()) {
        return;
    }
    JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
    bodyInterface.RemoveBody(it->second);
    bodyInterface.DestroyBody(it->second);
    chunkBodies_.erase(it);
}

void PhysicsWorld::syncChunkBodies(glm::vec3 worldPos) {
    const float chunkWorldSize = static_cast<float>(kChunkSize) * kVoxelSize;
    const ChunkCoord center(static_cast<int>(std::floor(worldPos.x / chunkWorldSize)),
                             static_cast<int>(std::floor(worldPos.y / chunkWorldSize)),
                             static_cast<int>(std::floor(worldPos.z / chunkWorldSize)));

    for (int dx = -kChunkBodyRadius; dx <= kChunkBodyRadius; ++dx) {
        for (int dy = -kChunkBodyRadius; dy <= kChunkBodyRadius; ++dy) {
            for (int dz = -kChunkBodyRadius; dz <= kChunkBodyRadius; ++dz) {
                const ChunkCoord coord = center + ChunkCoord(dx, dy, dz);
                if (voxelWorld_.isChunkLoaded(coord)) {
                    addOrRefreshChunkBody(coord);
                }
            }
        }
    }

    for (auto it = chunkBodies_.begin(); it != chunkBodies_.end();) {
        const ChunkCoord d = it->first - center;
        const bool inRadius =
            std::abs(d.x) <= kChunkBodyRadius && std::abs(d.y) <= kChunkBodyRadius && std::abs(d.z) <= kChunkBodyRadius;
        if (!inRadius) {
            JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
            bodyInterface.RemoveBody(it->second);
            bodyInterface.DestroyBody(it->second);
            it = chunkBodies_.erase(it);
        } else {
            ++it;
        }
    }

    // Chunks edited (digSphere) since the last sync: rebuild their shape if
    // we're currently tracking a body for them. Edits to chunks outside the
    // tracked radius are dropped here — World::chunkMeshVertices already
    // reflects the edit, so the body gets built fresh (with up-to-date
    // geometry) whenever that chunk next enters the radius.
    for (const ChunkCoord& coord : voxelWorld_.takeDirtyTerrainChunks()) {
        if (chunkBodies_.find(coord) != chunkBodies_.end()) {
            addOrRefreshChunkBody(coord);
        }
    }
}

JPH::BodyID PhysicsWorld::spawnCapsuleBody(glm::vec3 position, glm::quat orientation, float radius, float halfHeight,
                                            bool applyToppleImpulse) {
    // Defensive validation, not a hypothetical: a degenerate/NaN capsule
    // handed to Jolt (zero/negative radius or half-height, or a position/
    // orientation gone NaN from an upstream bug) doesn't fail cleanly — it
    // produces exploding contact forces that can hang the solver before
    // eventually corrupting memory. Refusing here turns that into a loud,
    // diagnosable stderr line instead of an unexplained freeze-then-crash.
    const bool positionFinite = std::isfinite(position.x) && std::isfinite(position.y) && std::isfinite(position.z);
    const bool orientationFinite = std::isfinite(orientation.x) && std::isfinite(orientation.y) &&
                                    std::isfinite(orientation.z) && std::isfinite(orientation.w);
    if (!(radius > 0.0f) || !(halfHeight > 0.0f) || !positionFinite || !orientationFinite) {
        std::fprintf(stderr,
                      "[Jolt] refused to spawn capsule body: radius=%.4f halfHeight=%.4f "
                      "position=(%.4f,%.4f,%.4f) orientation=(%.4f,%.4f,%.4f,%.4f)\n",
                      static_cast<double>(radius), static_cast<double>(halfHeight), static_cast<double>(position.x),
                      static_cast<double>(position.y), static_cast<double>(position.z), static_cast<double>(orientation.x),
                      static_cast<double>(orientation.y), static_cast<double>(orientation.z),
                      static_cast<double>(orientation.w));
        return JPH::BodyID();
    }

    JPH::CapsuleShapeSettings shapeSettings(halfHeight, radius);
    const JPH::ShapeSettings::ShapeResult shapeResult = shapeSettings.Create();
    if (shapeResult.HasError()) {
        std::fprintf(stderr, "[Jolt] capsule shape build failed: %s\n", shapeResult.GetError().c_str());
        return JPH::BodyID();
    }

    const float volume = JPH::JPH_PI * radius * radius * (4.0f / 3.0f * radius + 2.0f * halfHeight);
    const float mass = kWoodDensityKgPerM3 * volume;

    JPH::BodyCreationSettings settings(shapeResult.Get(), toJph(position), toJph(orientation), JPH::EMotionType::Dynamic,
                                        Layers::kMoving);
    settings.mOverrideMassProperties = JPH::EOverrideMassProperties::CalculateInertia;
    settings.mMassPropertiesOverride.mMass = mass;

    JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
    const JPH::BodyID id = bodyInterface.CreateAndAddBody(settings, JPH::EActivation::Activate);
    if (!id.IsInvalid() && applyToppleImpulse) {
        // A perfectly cylindrical capsule spawned at rest on a flat cut
        // face is a degenerate equilibrium — nudge it so it visibly topples
        // instead of sitting frozen on its end.
        bodyInterface.AddAngularImpulse(id, JPH::Vec3(mass * 0.4f, 0.0f, mass * 0.15f));
    }
    return id;
}

JPH::BodyID PhysicsWorld::spawnDebugBoxBody(glm::vec3 position, glm::vec3 halfExtents) {
    JPH::BodyCreationSettings settings(new JPH::BoxShape(JPH::Vec3(halfExtents.x, halfExtents.y, halfExtents.z)),
                                        toJph(position), JPH::Quat::sIdentity(), JPH::EMotionType::Dynamic,
                                        Layers::kMoving);
    JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
    return bodyInterface.CreateAndAddBody(settings, JPH::EActivation::Activate);
}

void PhysicsWorld::removeBody(JPH::BodyID id) {
    JPH::BodyInterface& bodyInterface = impl_->physicsSystem.GetBodyInterface();
    bodyInterface.RemoveBody(id);
    bodyInterface.DestroyBody(id);
}

glm::mat4 PhysicsWorld::bodyTransform(JPH::BodyID id) const {
    JPH::RVec3 position;
    JPH::Quat rotation;
    impl_->physicsSystem.GetBodyInterface().GetPositionAndRotation(id, position, rotation);
    const glm::mat4 translation = glm::translate(glm::mat4(1.0f), toGlm(position));
    return translation * glm::mat4_cast(toGlm(rotation));
}

bool PhysicsWorld::bodyIsActive(JPH::BodyID id) const {
    return impl_->physicsSystem.GetBodyInterface().IsActive(id);
}

void PhysicsWorld::setBodyTransform(JPH::BodyID id, glm::vec3 position, glm::quat rotation) {
    impl_->physicsSystem.GetBodyInterface().SetPositionAndRotation(id, toJph(position), toJph(rotation),
                                                                     JPH::EActivation::DontActivate);
}

} // namespace fgp
