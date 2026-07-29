#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/quaternion.hpp>

#if defined(__linux__)
// X11 key autorepeat delivers a continuous stream of synthetic KeyPress
// events while a key is held — confirmed (via an XTest-driven repro
// isolating this one variable) to starve out cursor-motion event delivery
// on this system, causing look() to stop being called entirely for as
// long as a movement key is held. Suppressing it while the game window
// has focus, restoring it the instant that focus is lost (see
// windowFocusCallback below), fixes that without touching the user's
// desktop otherwise.
#define GLFW_EXPOSE_NATIVE_X11
#include <GLFW/glfw3native.h>
#include <X11/Xlib.h>
#endif

#include "Camera.hpp"
#include "Crosshair.hpp"
#include "Hotbar.hpp"
#include "HudText.hpp"
#include "Inventory.hpp"
#include "ItemPickup.hpp"
#include "Paths.hpp"
#include "Player.hpp"
#include "PlayerMesh.hpp"
#include "PostProcess.hpp"
#include "Shader.hpp"
#include "Texture.hpp"
#include "physics/PhysicsWorld.hpp"
#include "voxel/ChunkMesh.hpp"
#include "voxel/SceneRaycast.hpp"
#include "voxel/TreeVoxels.hpp"
#include "voxel/VoxelRaycast.hpp"
#include "voxel/World.hpp"

namespace {

constexpr int kInitialWidth = 640;
constexpr int kInitialHeight = 360;

constexpr float kDigTickSeconds = 0.35f;
constexpr float kDigReachMeters = 5.0f;
constexpr float kDigRadiusMeters = 0.35f;

// Chup (RMB, karate-chop): shears a thin horizontal disc of Wood voxels
// out of the trunk per hit — see TreeVoxels.hpp's chopTree. Unlike scoop,
// chup does NOT need gesture-anchoring: each hit actually removes geometry
// (there's no invisible damage counter), so re-raycasting every tick
// naturally keeps landing on the same spot as long as aim doesn't change
// (scoop's anchor exists specifically because digSphere/chopTree clear
// geometry immediately, which would otherwise let a held click drill
// through to whatever's newly exposed behind the voxel just cleared —
// chup's disc is thin enough, and re-aims at the same point precisely
// enough, that this isn't a practical problem the way a full sphere would
// be).
constexpr float kChupTickSeconds = 0.25f;
constexpr float kChupReachMeters = 5.0f;
constexpr float kChupHorizontalRadiusMeters = 0.22f; // comfortably covers max trunk radius (~0.2m)
constexpr float kChupVerticalHalfThicknessMeters = 0.06f; // thin "shear" cut, not a gouge

// Debris: a stubbed visual only (no physics yet — see PhysicsWorld/
// milestone 3) for voxels cleared by chup/scoop-on-foliage. Small colored
// cubes ejected with a random puff velocity and simple kinematic fall,
// despawning after a short lifetime.
constexpr float kDebrisLifetimeSeconds = 1.2f;
constexpr float kDebrisGravity = -9.0f;
constexpr float kDebrisHalfExtent = 0.035f;
constexpr int kMaxDebrisPerClear = 12; // caps draw calls for a big scoop/chop in one hit

// Item drops: rolled once per clear tick (kDigTickSeconds/kChupTickSeconds),
// not per voxel — a held scoop/chup already fires several times a second,
// so per-tick odds are enough to feel frequent without a pickup per voxel.
// Leaves come from foliage only; sticks can come from either (a snapped
// twig off the canopy, or a chip off the trunk) but are rarer than leaves
// either way, per "leaves are more common."
constexpr float kLeafDropChance = 0.35f;
constexpr float kStickFromFoliageDropChance = 0.10f;
constexpr float kStickFromWoodDropChance = 0.30f;

// A scoop is a single gesture, not a continuous stream: re-raycasting every
// tick made the dig point creep deeper along the view ray as each tick
// cleared the voxels the previous raycast had stopped at, drilling a tunnel
// instead of hollowing out one spot. So the aim is latched once per gesture
// and only re-raycast once it drifts past these thresholds — small holding
// jitter keeps re-targeting the same already-carved spot, which is a no-op.
constexpr float kDigReanchorPositionEpsilon = 0.05f; // meters
constexpr float kDigReanchorDirectionEpsilon = 0.995f; // cos(angle); ~5.7 degrees

constexpr float kFovAdjustDegreesPerSecond = 40.0f;
constexpr float kMinFovDegrees = 30.0f;
constexpr float kMaxFovDegrees = 120.0f;

// Chromatic aberration offset is in UV space (fraction of screen), so its
// useful range is tiny; color bleed is an additive strength on top of the
// mip-blurred scene, so it can run higher before washing the image out.
// Both sweep their full range in ~2 seconds of holding the key, matching
// the FOV adjustment's feel above.
constexpr float kAberrationAdjustPerSecond = 0.01f;
constexpr float kMinAberration = 0.0f;
constexpr float kMaxAberration = 0.02f;
constexpr float kBleedAdjustPerSecond = 0.5f;
constexpr float kMinBleed = 0.0f;
constexpr float kMaxBleed = 1.0f;

// How far out the crosshair-distance HUD readout looks for something to
// report on; matches the projection's far clip plane so it can report
// anything actually visible.
constexpr float kHudRaycastReachMeters = 100.0f;

// Exponential smoothing factor for the FPS readout — raw 1/frameTime is too
// jittery frame-to-frame to read.
constexpr float kFpsSmoothing = 0.1f;

constexpr int kHudMarginX = 10;
constexpr int kHudLineHeight = 28;

// Fixed-timestep physics: the initial full-radius chunk load is synchronous
// (see World's streaming comment) and can spike a frame by hundreds of ms.
// At 0.1m voxels, integrating a big raw deltaTime in one step would tunnel
// the player through terrain. Substepping at a small fixed dt bounds how far
// any single step can move regardless of frame time.
constexpr float kFixedTimestep = 1.0f / 120.0f;
constexpr float kMaxFrameTime = 0.1f;
constexpr int kMaxSubsteps = 8;

const glm::vec3 kPlayerBodyColor(0.85f, 0.65f, 0.45f);

// Milestone-1 physics smoke test: a hardcoded dynamic box dropped above the
// player at startup, to confirm Jolt bodies actually fall and collide with
// terrain before anything gameplay-facing (severed logs, etc.) depends on
// it. Not a real gameplay object — remove once tree/log spawning exercises
// the same PhysicsWorld path.
const glm::vec3 kDebugBoxHalfExtents(0.25f);
const glm::vec3 kDebugBoxSpawnOffset(0.0f, 6.0f, -3.0f);
const glm::vec3 kDebugBoxColor(0.9f, 0.2f, 0.2f);

// Simple 6-face box, all faces always exposed (no neighbor culling needed —
// this is one standalone debug prop, not voxel terrain). Winding isn't
// hand-verified per face; draw with face culling disabled, same treatment
// main.cpp already gives the placeholder player mesh below.
std::vector<fgp::Vertex> buildDebugBoxMesh(glm::vec3 halfExtents, glm::vec3 color) {
    const glm::vec3 h = halfExtents;
    struct Face {
        glm::vec3 normal, c0, c1, c2, c3;
    };
    const std::array<Face, 6> faces = {{
        {{1.0f, 0.0f, 0.0f}, {h.x, -h.y, -h.z}, {h.x, -h.y, h.z}, {h.x, h.y, h.z}, {h.x, h.y, -h.z}},
        {{-1.0f, 0.0f, 0.0f}, {-h.x, -h.y, h.z}, {-h.x, -h.y, -h.z}, {-h.x, h.y, -h.z}, {-h.x, h.y, h.z}},
        {{0.0f, 1.0f, 0.0f}, {-h.x, h.y, -h.z}, {h.x, h.y, -h.z}, {h.x, h.y, h.z}, {-h.x, h.y, h.z}},
        {{0.0f, -1.0f, 0.0f}, {-h.x, -h.y, h.z}, {h.x, -h.y, h.z}, {h.x, -h.y, -h.z}, {-h.x, -h.y, -h.z}},
        {{0.0f, 0.0f, 1.0f}, {h.x, -h.y, h.z}, {-h.x, -h.y, h.z}, {-h.x, h.y, h.z}, {h.x, h.y, h.z}},
        {{0.0f, 0.0f, -1.0f}, {-h.x, -h.y, -h.z}, {h.x, -h.y, -h.z}, {h.x, h.y, -h.z}, {-h.x, h.y, -h.z}},
    }};

    std::vector<fgp::Vertex> out;
    out.reserve(36);
    for (const Face& f : faces) {
        out.push_back({f.c0, color, {0.0f, 0.0f}, f.normal});
        out.push_back({f.c1, color, {1.0f, 0.0f}, f.normal});
        out.push_back({f.c2, color, {1.0f, 1.0f}, f.normal});
        out.push_back({f.c0, color, {0.0f, 0.0f}, f.normal});
        out.push_back({f.c2, color, {1.0f, 1.0f}, f.normal});
        out.push_back({f.c3, color, {0.0f, 1.0f}, f.normal});
    }
    return out;
}

// Above the generator's max surface height (baseHeight_ + amplitude_ ~= 8.8m)
// so the world is visible on the horizon without the player starting
// underground.
fgp::Player g_player(glm::vec3(0.0f, 12.0f, 20.0f));
fgp::Camera g_camera;
float g_lastMouseX = kInitialWidth / 2.0f;
float g_lastMouseY = kInitialHeight / 2.0f;
bool g_firstMouse = true;
// Accumulated here by cursorPosCallback (which can fire multiple times per
// frame — GLFW drains its whole platform event queue on one glfwPollEvents()
// call) and applied to the player exactly once per frame, right before
// physics runs. This keeps look() off the event-pump's call stack entirely:
// it used to run per-motion-event, so a frame with a burst of queued events
// (e.g. after any stall) did several partial, non-atomic yaw/pitch updates
// instead of one coherent one, and the fixed-timestep substep loop below
// could see front_/right_ change mid-way through queued events it had
// nothing to do with.
glm::vec2 g_lookDelta(0.0f);
float g_digCooldown = 0.0f;
bool g_digAnchored = false;
glm::vec3 g_digAnchorOrigin(0.0f);
glm::vec3 g_digAnchorDirection(0.0f, 0.0f, -1.0f);
float g_chupCooldown = 0.0f;

// See kDebrisLifetimeSeconds's comment — a stubbed "flies off" visual, not
// real physics.
struct Debris {
    glm::vec3 position;
    glm::vec3 velocity;
    fgp::Material material;
    float spawnTime;
};
std::vector<Debris> g_debris;
float g_currentTime = 0.0f; // set once per frame in run()'s loop, read by spawnDebris/updateDebris

// A severed trunk (+ whatever canopy came with it — see the chup handler's
// comment) as a real falling/colliding Jolt body. The render mesh is the
// actual chipped voxel geometry, expressed relative to the capsule's own
// center so translate(bodyTransform) reproduces its spawn position exactly
// and keeps rotating correctly as the body tumbles — the physics shape
// itself is a simpler capsule proxy (JPH::MeshShape can't be dynamic, see
// PhysicsWorld.hpp).
//
// voxels is retained (not discarded after the initial mesh upload) so a
// felled log stays scoop/chup-interactable indefinitely, same as a
// standing TreeInstance — see raycastLogs/chopVoxelGrid. It's expressed in
// the SAME local frame the mesh/capsule pivot use (see the spawn sites):
// local (0,0,0) is the capsule's own center, and world position/
// orientation come fresh from physicsWorld.bodyTransform every frame
// rather than being cached here, since the body tumbles.
struct DynamicLog {
    JPH::BodyID body;
    std::unique_ptr<fgp::ChunkMesh> mesh;
    fgp::TreeVoxelGrid voxels;
    float radiusMeters = 0.0f;  // capsule radius, fixed at creation and reused across any further re-severance
    bool wasActive = true;      // settle-pass edge trigger — spawnCapsuleBody always creates bodies Activated

    // Snap-on-sleep state (see the "Felled-log interactivity" section's
    // trySnapLog/runLogSettlePass) — see World::isSolidIncludingSnappedLogs's
    // doc comment for why this whole mechanism is a stopgap, not a design.
    // `snapped` is the source of truth for whether this log currently
    // participates in player collision/raycasts as ground; the axis/origin
    // fields below are ALSO source of truth once snapped == true (never
    // re-derived from physicsWorld.bodyTransform on later frames, which
    // would reintroduce float drift into what's meant to be an exact
    // lattice fact) — trySnapLog is the only place that writes them.
    bool snapped = false;
    glm::ivec3 snappedWorldVoxelOrigin{0};
    glm::ivec3 snappedAxisX{1, 0, 0};
    glm::ivec3 snappedAxisY{0, 1, 0};
    glm::ivec3 snappedAxisZ{0, 0, 1};
    glm::ivec3 snappedNegMask{0}; // see fgp::SnappedSolidGrid::negMask's comment
};
// NOTE (future generalization seam): the snap-on-sleep + walkability +
// foliage-shatter-on-settle machinery below doesn't actually depend on this
// being a TREE log — it only depends on "a TreeVoxelGrid riding a Jolt
// body." When the (currently out-of-scope) floating-terrain-voxel-detach
// system eventually exists, it will want the same snap/walkable/shatter
// machinery for a chunk of detached terrain instead of a felled tree. At
// that point THIS struct is the thing to generalize/rename (e.g. a shared
// DynamicVoxelBody base with DynamicLog as one instantiation) — not before,
// since nothing else needs it yet.
//
// NOT a global: ChunkMesh's destructor makes GL calls, and globals are
// destroyed after main() returns — after run() has already called
// glfwTerminate() and torn down the GL context, which segfaults. Lives in
// run()'s local scope instead (see its declaration there), passed down to
// processNonMovementInput by reference, same as world/physicsWorld already
// are for the same reason.
bool g_ragballKeyWasDown = false;
bool g_bKeyWasDown = false;
bool g_debugAddItemKeyWasDown = false;
bool g_perspectiveKeyWasDown = false;
bool g_cursorFreeKeyWasDown = false;
bool g_captureClickWasDown = false;
bool g_escapeKeyWasDown = false;
// Starts free (visible, unlocked) so the window is immediately resizable/
// movable on launch; a click into the viewport captures it for mouselook.
bool g_cursorFree = true;
float g_fpsSmoothed = 0.0f;
// Worst *unclamped* frame time seen in the last second, in milliseconds.
// The FPS readout above clamps to kMaxFrameTime and heavily smooths, so a
// hitch that lasts a single frame barely moves it — this exists to actually
// see stalls the FPS number can't show.
float g_worstFrameMsInWindow = 0.0f;
float g_worstFrameMsDisplay = 0.0f;
float g_worstFrameWindowElapsed = 0.0f;
// Defaults picked to be visible but not distracting; both are dialable
// in-game with [ / ] (aberration) and ; / ' (bleed).
float g_aberrationStrength = 0.0f;
float g_bleedStrength = 0.12f;

const glm::quat kIdentityRotation(1.0f, 0.0f, 0.0f, 0.0f);

void spawnDebris(glm::vec3 worldPos, fgp::Material material) {
    // Random-ish outward+upward "puff" — a stub, not real physics, so
    // std::rand() is fine (no need for the world-gen hashing's determinism).
    const glm::vec3 velocity((static_cast<float>(std::rand() % 200) / 100.0f - 1.0f) * 1.2f,
                              1.5f + static_cast<float>(std::rand() % 100) / 100.0f * 1.5f,
                              (static_cast<float>(std::rand() % 200) / 100.0f - 1.0f) * 1.2f);
    g_debris.push_back(Debris{worldPos, velocity, material, g_currentTime});
}

// Spawns debris for up to kMaxDebrisPerClear of the given cleared voxels
// (evenly sampled, not just the first N) so a big scoop/chop in one hit
// doesn't dump dozens of extra draw calls on the render loop. rootRotation
// is identity for a standing tree (translation-only rootWorld) but matters
// for a felled/tumbled DynamicLog — see raycastLogs.
void spawnDebrisForCleared(const std::vector<glm::ivec3>& clearedLocal, glm::vec3 rootWorld, glm::quat rootRotation,
                            fgp::Material material) {
    if (clearedLocal.empty()) {
        return;
    }
    const std::size_t step = std::max<std::size_t>(1, clearedLocal.size() / kMaxDebrisPerClear);
    for (std::size_t i = 0; i < clearedLocal.size(); i += step) {
        const glm::vec3 worldPos = rootWorld + rootRotation * ((glm::vec3(clearedLocal[i]) + 0.5f) * fgp::kVoxelSize);
        spawnDebris(worldPos, material);
    }
}

void updateDebris(float dt) {
    for (auto it = g_debris.begin(); it != g_debris.end();) {
        it->velocity.y += kDebrisGravity * dt;
        it->position += it->velocity * dt;
        if (g_currentTime - it->spawnTime > kDebrisLifetimeSeconds) {
            it = g_debris.erase(it);
        } else {
            ++it;
        }
    }
}

// World Y of the terrain surface directly below pos — the height a pickup
// spawned at pos will fall to (see PickupField's groundY). Raycasts
// straight down through terrain (never trees — raycastVoxel only queries
// World's terrain grid, so this passes straight through the tree that's
// being cleared); falls back to pos's own height if nothing solid is found
// within range, so it doesn't fall forever over open air/a chasm.
float terrainGroundY(const fgp::World& world, glm::vec3 pos) {
    const auto groundHit = fgp::raycastVoxel(world, pos, glm::vec3(0.0f, -1.0f, 0.0f), 60.0f);
    if (!groundHit) {
        return pos.y;
    }
    return (static_cast<float>(groundHit->y) + 1.0f) * fgp::kVoxelSize;
}

float rollUnit() { return static_cast<float>(std::rand()) / static_cast<float>(RAND_MAX); }

// Scatters a spawn point sideways by a random amount in [minRadiusMeters,
// maxRadiusMeters) so two pickups from the same tick don't land exactly
// coincident (interpenetrating billboards), and so a stick dropped near a
// trunk lands clear of the trunk's own collision-free-but-visually-solid
// geometry instead of appearing embedded in it. Applied before the fall
// (not after), so the pickup visibly drops straight down from this
// scattered point rather than jumping sideways once it lands.
glm::vec3 jitterHorizontal(glm::vec3 pos, float minRadiusMeters, float maxRadiusMeters) {
    const float angle = rollUnit() * 6.2831853f;
    const float radius = minRadiusMeters + rollUnit() * (maxRadiusMeters - minRadiusMeters);
    return pos + glm::vec3(std::cos(angle) * radius, 0.0f, std::sin(angle) * radius);
}

// One roll for a Leaf, one (lower-odds) roll for a Stick — independent, so
// occasionally both drop from the same tick, matching "chance at spawning
// leaves and sticks" rather than a guaranteed one-of-each per gesture. Each
// spawns at (a jittered) clearPos and falls from there — see PickupField.
void spawnFoliagePickups(fgp::PickupField& pickupField, const fgp::World& world, glm::vec3 clearPos) {
    if (rollUnit() < kLeafDropChance) {
        const glm::vec3 spawnPos = jitterHorizontal(clearPos, 0.05f, 0.2f);
        pickupField.spawn(spawnPos, fgp::ItemType::Leaf, g_currentTime, terrainGroundY(world, spawnPos));
    }
    if (rollUnit() < kStickFromFoliageDropChance) {
        const glm::vec3 spawnPos = jitterHorizontal(clearPos, 0.05f, 0.2f);
        pickupField.spawn(spawnPos, fgp::ItemType::Stick, g_currentTime, terrainGroundY(world, spawnPos));
    }
}

void spawnWoodPickups(fgp::PickupField& pickupField, const fgp::World& world, glm::vec3 clearPos) {
    if (rollUnit() < kStickFromWoodDropChance) {
        // Wider/farther-out radius than foliage: clearPos sits right at the
        // trunk surface, so a small jitter could still land inside it.
        const glm::vec3 spawnPos = jitterHorizontal(clearPos, 0.15f, 0.35f);
        pickupField.spawn(spawnPos, fgp::ItemType::Stick, g_currentTime, terrainGroundY(world, spawnPos));
    }
}

// --- Felled-log interactivity -------------------------------------------
//
// A DynamicLog's voxels are ALWAYS expressed in a frame where grid-local
// (0,0,0) is that log's own current capsule pivot — see rebaseGridToPivot,
// called at every point a DynamicLog is created or re-severed. That's what
// lets raycastLogs/digVoxelGridSphere/chopVoxelGrid below use
// physicsWorld.bodyTransform(log.body)'s position/rotation directly as
// gridPosition/gridRotation with no extra bookkeeping, the same way a
// standing TreeInstance uses its unrotated rootWorld directly.

bool gridIsEmpty(const fgp::TreeVoxelGrid& grid) {
    for (fgp::Material m : grid.cells) {
        if (m != fgp::Material::Air) {
            return false;
        }
    }
    return true;
}

// The vertical center (in grid's OWN current local-Y convention) and
// half-height of grid's occupied bounds — every piece that becomes (or
// stays) a DynamicLog gets re-centered/re-based around this exact point via
// rebaseGridToPivot right after, so it becomes that piece's new pivot.
// shiftVoxels (an integer voxel count) is the source of truth; localY is
// derived FROM it, not independently rounded — rebaseGridToPivot shifts
// originLocal by the same shiftVoxels, so the capsule's spawn offset
// (built from localY) and the grid's new local-space meaning always agree
// exactly, with no separate float/int rounding to drift apart.
struct GridPivot {
    int shiftVoxels;
    float localY;
    float halfHeightMeters;
};

GridPivot computeGridPivot(const fgp::TreeVoxelGrid& grid) {
    const float heightVoxels = static_cast<float>(grid.dims.y);
    const float centerYVoxels = -static_cast<float>(grid.originLocal.y) + heightVoxels * 0.5f;
    const int shiftVoxels = static_cast<int>(std::lround(centerYVoxels));
    return GridPivot{shiftVoxels, static_cast<float>(shiftVoxels) * fgp::kVoxelSize, heightVoxels * fgp::kVoxelSize * 0.5f};
}

// Shifts grid.originLocal so grid-local (0,0,0) becomes pivot.localY of
// grid's OLD local-Y convention. After this, buildTreeVoxelMesh(grid)
// produces vertices already centered on the pivot with no manual
// post-shift needed (buildTreeVoxelMesh computes local = gridIndex -
// originLocal, so shifting originLocal is equivalent to shifting every
// vertex by the same amount).
void rebaseGridToPivot(fgp::TreeVoxelGrid& grid, const GridPivot& pivot) {
    grid.originLocal.y += pivot.shiftVoxels;
}

// --- Snap-on-sleep -------------------------------------------------------
// See World::isSolidIncludingSnappedLogs's doc comment for the mandatory
// "this is a temporary, unacceptable stopgap" explanation — everything
// below exists only to let a felled log that happens to come to rest at a
// (nearly) axis-aligned orientation become walkable/solid, by rounding it
// the rest of the way onto the world's voxel lattice. A log resting at a
// genuine off-axis tilt gets none of this.

// The 3 integer-axis columns of a rotation snapped to one of the 24 proper
// cube orientations — each is exactly one of (+-1,0,0)/(0,+-1,0)/(0,0,+-1).
struct CubeSnap {
    glm::ivec3 axisX, axisY, axisZ;
};

// Nearest signed unit basis vector to v, optionally excluding one axis
// index (used below so Y's snap can't collide with X's already-chosen
// axis).
glm::ivec3 nearestUnitBasis(glm::vec3 v, int excludeAxis = -1) {
    int bestAxis = -1;
    float bestVal = 0.0f;
    float bestAbs = -1.0f;
    for (int axis = 0; axis < 3; ++axis) {
        if (axis == excludeAxis) {
            continue;
        }
        const float val = v[axis];
        const float a = std::abs(val);
        if (a > bestAbs) {
            bestAbs = a;
            bestAxis = axis;
            bestVal = val;
        }
    }
    glm::ivec3 result(0);
    result[bestAxis] = bestVal >= 0.0f ? 1 : -1;
    return result;
}

// Snaps X's column to its nearest basis vector, then Y's column to its
// nearest basis vector on one of the two remaining axes (excluding X's
// axis, so X/Y can never collapse onto the same axis), then derives Z as
// the exact integer cross product of the two — guaranteed right-handed
// (det=+1) since rotation matrices from a quaternion always are, and X/Y
// here are drawn from two distinct axes of that same proper matrix.
CubeSnap snapRotationToCube(glm::quat rotation) {
    const glm::mat3 m = glm::mat3_cast(rotation);
    const glm::ivec3 axisX = nearestUnitBasis(m[0]);
    const int xAxisIndex = axisX.x != 0 ? 0 : (axisX.y != 0 ? 1 : 2);
    const glm::ivec3 axisY = nearestUnitBasis(m[1], xAxisIndex);
    const glm::ivec3 axisZ(axisX.y * axisY.z - axisX.z * axisY.y, axisX.z * axisY.x - axisX.x * axisY.z,
                            axisX.x * axisY.y - axisX.y * axisY.x);
    return CubeSnap{axisX, axisY, axisZ};
}

glm::quat cubeSnapToQuat(const CubeSnap& snap) {
    const glm::mat3 m(glm::vec3(snap.axisX), glm::vec3(snap.axisY), glm::vec3(snap.axisZ));
    return glm::quat_cast(m);
}

// A voxel is the unit CUBE [local, local+1), not a point, so under a
// signed permutation with a -1 entry, R*local is NOT that cube's world-
// space min corner — rotating [0,1) 180 degrees about an axis moves it to
// [-1,0), not [0,1). This is the per-axis correction: -1 on every world
// axis some local axis maps to with a negative sign, 0 otherwise. See
// fgp::SnappedSolidGrid::negMask's comment (World.hpp) for the full
// explanation — every forward/inverse mapping between a snapped log's
// local grid and world voxel coordinates needs this, not just R.
glm::ivec3 negMaskFor(const CubeSnap& snap) {
    return glm::min(snap.axisX, 0) + glm::min(snap.axisY, 0) + glm::min(snap.axisZ, 0);
}

// Vertical lift (in voxels) trySnapLog will search before giving up — small
// enough that a log which needs more than this to clear terrain is
// genuinely resting unevenly (a slope, a rock), not just sitting a hair low
// from float settling.
constexpr int kMaxSnapLiftVoxels = 4;

// Attempts to commit log to an axis-aligned, lattice-aligned rest pose:
// snaps its current rotation to the nearest cube orientation, its position
// to the voxel lattice, then searches a small vertical lift range for the
// first height where none of the log's occupied cells overlap existing
// solids (terrain or another already-snapped log — world's own registry
// doesn't include `log` itself yet at this point, see runLogSettlePass).
// Returns false (log stays unsnapped/walk-through) if no lift within
// kMaxSnapLiftVoxels clears it — e.g. a log resting on a real slope. That's
// the accepted, documented failure mode, not a bug to chase.
bool trySnapLog(DynamicLog& log, const fgp::World& world, fgp::PhysicsWorld& physicsWorld) {
    const glm::mat4 transform = physicsWorld.bodyTransform(log.body);
    const glm::vec3 position(transform[3]);
    const glm::quat rotation = glm::quat_cast(transform);
    const CubeSnap snap = snapRotationToCube(rotation);
    const glm::ivec3 latticeOrigin(static_cast<int>(std::lround(position.x / fgp::kVoxelSize)),
                                    static_cast<int>(std::lround(position.y / fgp::kVoxelSize)),
                                    static_cast<int>(std::lround(position.z / fgp::kVoxelSize)));

    const glm::ivec3 negMask = negMaskFor(snap);
    const fgp::TreeVoxelGrid& grid = log.voxels;
    for (int lift = 0; lift <= kMaxSnapLiftVoxels; ++lift) {
        const glm::ivec3 originCandidate = latticeOrigin + glm::ivec3(0, lift, 0);
        bool blocked = false;
        for (int gy = 0; gy < grid.dims.y && !blocked; ++gy) {
            for (int gz = 0; gz < grid.dims.z && !blocked; ++gz) {
                for (int gx = 0; gx < grid.dims.x && !blocked; ++gx) {
                    const glm::ivec3 g(gx, gy, gz);
                    if (!fgp::isSolid(grid.cells[grid.index(g)])) {
                        continue;
                    }
                    const glm::ivec3 local = g - grid.originLocal;
                    const glm::ivec3 worldVoxel = originCandidate + negMask + local.x * snap.axisX +
                                                   local.y * snap.axisY + local.z * snap.axisZ;
                    if (world.isSolidIncludingSnappedLogs(worldVoxel)) {
                        blocked = true;
                        break;
                    }
                }
            }
        }
        if (!blocked) {
            log.snapped = true;
            log.snappedWorldVoxelOrigin = originCandidate;
            log.snappedAxisX = snap.axisX;
            log.snappedAxisY = snap.axisY;
            log.snappedAxisZ = snap.axisZ;
            log.snappedNegMask = negMask;
            physicsWorld.setBodyTransform(log.body, glm::vec3(originCandidate) * fgp::kVoxelSize, cubeSnapToQuat(snap));
            return true;
        }
    }
    return false;
}

// Foliage-impact shatter: for every Leaf cell in a freshly-snapped log's
// grid, checks whether it (or a face-adjacent cell) is now touching a solid
// world voxel — terrain OR another already-snapped log, via the same
// unified query walkability uses, which is what lets this catch a canopy
// landing on another log exactly the same way it catches landing on the
// ground. Crushed cells are cleared and dispatched through the same
// debris/pickup helpers chop/scoop already use.
void runFoliageShatter(DynamicLog& log, fgp::World& world, fgp::PickupField& pickupField) {
    static constexpr glm::ivec3 kSelfAndNeighborOffsets[7] = {
        {0, 0, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1},
    };

    fgp::TreeVoxelGrid& grid = log.voxels;
    std::vector<glm::ivec3> crushedLocal;
    for (int gy = 0; gy < grid.dims.y; ++gy) {
        for (int gz = 0; gz < grid.dims.z; ++gz) {
            for (int gx = 0; gx < grid.dims.x; ++gx) {
                const glm::ivec3 g(gx, gy, gz);
                if (grid.cells[grid.index(g)] != fgp::Material::Leaf) {
                    continue;
                }
                const glm::ivec3 local = g - grid.originLocal;
                const glm::ivec3 worldVoxel = log.snappedWorldVoxelOrigin + log.snappedNegMask +
                                               local.x * log.snappedAxisX + local.y * log.snappedAxisY +
                                               local.z * log.snappedAxisZ;
                for (const glm::ivec3& offset : kSelfAndNeighborOffsets) {
                    if (world.isSolidIncludingSnappedLogs(worldVoxel + offset)) {
                        crushedLocal.push_back(local);
                        break;
                    }
                }
            }
        }
    }
    if (crushedLocal.empty()) {
        return;
    }
    for (const glm::ivec3& local : crushedLocal) {
        grid.set(local, fgp::Material::Air);
    }
    log.mesh->upload(fgp::buildTreeVoxelMesh(grid));

    const glm::vec3 rootWorld = glm::vec3(log.snappedWorldVoxelOrigin) * fgp::kVoxelSize;
    const glm::quat rootRotation = cubeSnapToQuat(CubeSnap{log.snappedAxisX, log.snappedAxisY, log.snappedAxisZ});
    spawnDebrisForCleared(crushedLocal, rootWorld, rootRotation, fgp::Material::Leaf);

    // Sampled subset, not one pickup roll per crushed voxel, so a big
    // canopy impact doesn't flood the pickup field — same reasoning as
    // spawnDebrisForCleared's own sampling.
    const std::size_t step = std::max<std::size_t>(1, crushedLocal.size() / kMaxDebrisPerClear);
    for (std::size_t i = 0; i < crushedLocal.size(); i += step) {
        const glm::vec3 worldPos = rootWorld + rootRotation * ((glm::vec3(crushedLocal[i]) + 0.5f) * fgp::kVoxelSize);
        spawnFoliagePickups(pickupField, world, worldPos);
    }
}

struct LogHit {
    std::size_t logIndex;
    glm::ivec3 localVoxel;
    glm::vec3 position; // log's current body position, captured at raycast time
    glm::quat rotation; // log's current body rotation, captured at raycast time
    float distance;
};

// Raycasts against every currently-tumbling/settled log's own voxel grid,
// using its CURRENT physics transform — mirrors raycastScene's terrain/tree
// merge, just for logs (which live here in main.cpp, not World, so they
// can't be folded into raycastScene itself without giving World a
// dependency on main.cpp-local state — see DynamicLog's own comment on why
// it's not global).
std::optional<LogHit> raycastLogs(const std::vector<DynamicLog>& logs, const fgp::PhysicsWorld& physicsWorld,
                                   glm::vec3 originWorld, glm::vec3 direction, float maxDistanceMeters) {
    std::optional<LogHit> best;
    float bestDistance = maxDistanceMeters;
    for (std::size_t i = 0; i < logs.size(); ++i) {
        const glm::mat4 transform = physicsWorld.bodyTransform(logs[i].body);
        const glm::vec3 position(transform[3]);
        const glm::quat rotation = glm::quat_cast(transform);
        const auto localVoxel =
            fgp::raycastVoxelGrid(logs[i].voxels, position, rotation, originWorld, direction, maxDistanceMeters);
        if (!localVoxel) {
            continue;
        }
        const glm::vec3 hitCenter = position + rotation * ((glm::vec3(*localVoxel) + 0.5f) * fgp::kVoxelSize);
        const float distance = glm::distance(originWorld, hitCenter);
        if (distance < bestDistance) {
            bestDistance = distance;
            best = LogHit{i, *localVoxel, position, rotation, distance};
        }
    }
    return best;
}

// TEMPORARY, BAD DESIGN — see SceneRaycast.hpp's comment on SceneHit, which
// this extends with a third member (LogHit) exactly the way that comment
// warns against. This is the variant whose incomplete narrowing ("if not a
// tree, assume it's a log") null-pointer-crashed chup on a plain terrain
// hit — the bug is fixed at the call sites below, but the design that made
// it easy to write is still here. Don't add a fourth member without
// replacing this with a uniform "always resolves to something in range"
// raycast result instead.
using ActionHit = std::variant<fgp::TerrainHit, fgp::TreeHit, LogHit>;

// Merges raycastScene (terrain+standing trees) with raycastLogs (felled
// logs), keeping whichever candidate is nearer — same merge pattern
// raycastScene already uses internally for its own two candidates, just
// extended with a third arm scoop/chup both need.
std::optional<ActionHit> raycastSceneAndLogs(fgp::World& world, const std::vector<DynamicLog>& logs,
                                              const fgp::PhysicsWorld& physicsWorld, glm::vec3 origin,
                                              glm::vec3 direction, float maxDistanceMeters) {
    std::optional<ActionHit> best;
    float bestDistance = maxDistanceMeters;

    if (const auto hit = fgp::raycastScene(world, origin, direction, maxDistanceMeters)) {
        if (const auto* terrainHit = std::get_if<fgp::TerrainHit>(&*hit)) {
            const glm::vec3 hitCenter = (glm::vec3(terrainHit->voxel) + 0.5f) * fgp::kVoxelSize;
            bestDistance = glm::distance(origin, hitCenter);
            best = ActionHit{*terrainHit};
        } else if (const auto* treeHit = std::get_if<fgp::TreeHit>(&*hit)) {
            const glm::vec3 hitCenter =
                treeHit->tree->rootWorld + (glm::vec3(treeHit->localVoxel) + 0.5f) * fgp::kVoxelSize;
            bestDistance = glm::distance(origin, hitCenter);
            best = ActionHit{*treeHit};
        }
    }

    if (const auto logHit = raycastLogs(logs, physicsWorld, origin, direction, maxDistanceMeters)) {
        if (logHit->distance < bestDistance) {
            best = ActionHit{*logHit};
        }
    }

    return best;
}

// Per-frame snap-on-sleep + foliage-shatter pass. Must run exactly once per
// frame, right after processNonMovementInput(...) and before
// world.update(...) in run()'s main loop — this ordering is load-bearing:
// processNonMovementInput is the only place dynamicLogs' size/order changes
// (push_back/erase from chop/re-severance), and the fixed-substep loop
// (which reads world's snapped-log registry via player collision) runs
// after this pass rebuilds that registry from the current frame's already-
// settled dynamicLogs. Don't add a registry read anywhere between
// processNonMovementInput and this function, and don't cache
// SnappedSolidGrid pointers across frames — the registry is rebuilt from
// scratch every frame specifically so re-severance/erasure/reallocation
// never need a manual unregister step.
void runLogSettlePass(std::vector<DynamicLog>& dynamicLogs, fgp::World& world, fgp::PhysicsWorld& physicsWorld,
                       fgp::PickupField& pickupField) {
    // Collected rather than erased inline: erasing from dynamicLogs while
    // holding a reference into it (the `log` below) would invalidate that
    // reference for the rest of this iteration.
    std::vector<std::size_t> toErase;
    for (std::size_t i = 0; i < dynamicLogs.size(); ++i) {
        DynamicLog& log = dynamicLogs[i];
        const bool active = physicsWorld.bodyIsActive(log.body);
        if (active && log.snapped) {
            // Woke up (e.g. something landed on it) — un-walkable until it
            // resettles and re-snaps. Expected stopgap behavior, not a bug.
            log.snapped = false;
        }
        if (!active && !log.snapped) {
            if (trySnapLog(log, world, physicsWorld)) {
                runFoliageShatter(log, world, pickupField);
                if (gridIsEmpty(log.voxels)) {
                    // Shattered away the last of it (a mostly-canopy piece
                    // whose every Leaf voxel was crushed) — without this,
                    // the capsule body would linger forever as an invisible
                    // physical obstacle other dynamic bodies could still
                    // collide against, same failure mode the chop handler
                    // already guards against for scoop/chup clears.
                    physicsWorld.removeBody(log.body);
                    toErase.push_back(i);
                }
            }
        }
        log.wasActive = active;
    }
    for (auto it = toErase.rbegin(); it != toErase.rend(); ++it) {
        dynamicLogs.erase(dynamicLogs.begin() + static_cast<std::ptrdiff_t>(*it));
    }

    std::vector<fgp::SnappedSolidGrid> grids;
    for (const DynamicLog& log : dynamicLogs) {
        if (log.snapped) {
            grids.push_back(fgp::SnappedSolidGrid{&log.voxels, log.snappedWorldVoxelOrigin, log.snappedAxisX,
                                                    log.snappedAxisY, log.snappedAxisZ, log.snappedNegMask});
        }
    }
    world.setSnappedSolidGrids(std::move(grids));
}

void framebufferSizeCallback(GLFWwindow*, int width, int height) {
    glViewport(0, 0, width, height);
}

#if defined(__linux__)
void setX11AutoRepeat(bool enabled) {
    Display* display = glfwGetX11Display();
    if (display == nullptr) {
        return;
    }
    if (enabled) {
        XAutoRepeatOn(display);
    } else {
        XAutoRepeatOff(display);
    }
}

void windowFocusCallback(GLFWwindow*, int focused) {
    setX11AutoRepeat(focused == GLFW_FALSE);
}
#endif

void cursorPosCallback(GLFWwindow*, double xpos, double ypos) {
    if (g_firstMouse) {
        g_lastMouseX = static_cast<float>(xpos);
        g_lastMouseY = static_cast<float>(ypos);
        g_firstMouse = false;
    }

    const float xOffset = static_cast<float>(xpos) - g_lastMouseX;
    // Screen-space Y grows downward; invert so moving the mouse up looks up.
    const float yOffset = g_lastMouseY - static_cast<float>(ypos);
    g_lastMouseX = static_cast<float>(xpos);
    g_lastMouseY = static_cast<float>(ypos);

    // While the cursor is free (window-management mode), ordinary mouse
    // movement over the client area shouldn't also spin the camera. Only
    // accumulate here — see g_lookDelta's comment for why it's applied to
    // the player once per frame instead of directly from this callback.
    if (!g_cursorFree) {
        g_lookDelta += glm::vec2(xOffset, yOffset);
    }
}

// GLFW key state is level-triggered (GLFW_PRESS for as long as it's held);
// mode/perspective toggles need edge detection so holding the key doesn't
// flip the state every frame.
bool consumeKeyPress(GLFWwindow* window, int key, bool& wasDown) {
    const bool isDown = glfwGetKey(window, key) == GLFW_PRESS;
    const bool justPressed = isDown && !wasDown;
    wasDown = isDown;
    return justPressed;
}

bool consumeMouseButtonPress(GLFWwindow* window, int button, bool& wasDown) {
    const bool isDown = glfwGetMouseButton(window, button) == GLFW_PRESS;
    const bool justPressed = isDown && !wasDown;
    wasDown = isDown;
    return justPressed;
}

fgp::PlayerInput gatherPlayerInput(GLFWwindow* window) {
    fgp::PlayerInput input;
    if (glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS) input.moveAxis.y += 1.0f;
    if (glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS) input.moveAxis.y -= 1.0f;
    if (glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS) input.moveAxis.x += 1.0f;
    if (glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS) input.moveAxis.x -= 1.0f;
    input.jumpPressed = glfwGetKey(window, GLFW_KEY_SPACE) == GLFW_PRESS;
    return input;
}

void processNonMovementInput(GLFWwindow* window, float deltaTime, fgp::World& world, fgp::PhysicsWorld& physicsWorld,
                              std::vector<DynamicLog>& dynamicLogs, fgp::Inventory& inventory, fgp::Hotbar& hotbar,
                              fgp::PickupField& pickupField) {
    // Escape's first job is "give me my mouse back" (the reflex for that is
    // universal); it only quits once the cursor is already free, so it
    // can't be mistaken for an instant-quit while captured.
    if (consumeKeyPress(window, GLFW_KEY_ESCAPE, g_escapeKeyWasDown)) {
        if (g_cursorFree) {
            glfwSetWindowShouldClose(window, true);
        } else {
            g_cursorFree = true;
            glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
            g_firstMouse = true;
        }
    }

    if (consumeKeyPress(window, GLFW_KEY_V, g_perspectiveKeyWasDown)) {
        g_camera.togglePerspective();
    }

    // GLFW_CURSOR_DISABLED hides and locks the OS pointer for mouselook,
    // which also makes it impossible to grab the window's edges/titlebar to
    // resize or move it. Left Alt releases the cursor for that (and any
    // other window-manager interaction), same convention as many games use
    // for "let me use my desktop for a second".
    if (consumeKeyPress(window, GLFW_KEY_LEFT_ALT, g_cursorFreeKeyWasDown)) {
        g_cursorFree = !g_cursorFree;
        glfwSetInputMode(window, GLFW_CURSOR, g_cursorFree ? GLFW_CURSOR_NORMAL : GLFW_CURSOR_DISABLED);
        // Avoid a big look-snap from the accumulated cursor delta while free.
        g_firstMouse = true;
    }

    // Clicking back into the viewport re-captures the mouse, the same
    // "click to focus" convention most windowed FPS games use — so the
    // window starts fully resizable/movable and only grabs the cursor once
    // you actually click into it to play. Always poll the button (rather
    // than short-circuiting on g_cursorFree) so the wasDown edge state
    // doesn't go stale while captured.
    const bool leftClickJustPressed = consumeMouseButtonPress(window, GLFW_MOUSE_BUTTON_LEFT, g_captureClickWasDown);
    bool capturedThisFrame = false;
    if (g_cursorFree && leftClickJustPressed) {
        g_cursorFree = false;
        glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
        g_firstMouse = true;
        capturedThisFrame = true;
    }

    // '-'/'=' (the unshifted keys sharing a slot with '_'/'+') adjust FOV
    // live so it can be dialed in by eye rather than guessed at in code.
    if (glfwGetKey(window, GLFW_KEY_MINUS) == GLFW_PRESS) {
        g_camera.fovDegrees -= kFovAdjustDegreesPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_EQUAL) == GLFW_PRESS) {
        g_camera.fovDegrees += kFovAdjustDegreesPerSecond * deltaTime;
    }
    g_camera.fovDegrees = std::clamp(g_camera.fovDegrees, kMinFovDegrees, kMaxFovDegrees);

    // '['/']' dial chromatic aberration, ';'/''' dial color bleed — same
    // hold-to-adjust convention as FOV above, on keys FOV isn't already using.
    if (glfwGetKey(window, GLFW_KEY_LEFT_BRACKET) == GLFW_PRESS) {
        g_aberrationStrength -= kAberrationAdjustPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_RIGHT_BRACKET) == GLFW_PRESS) {
        g_aberrationStrength += kAberrationAdjustPerSecond * deltaTime;
    }
    g_aberrationStrength = std::clamp(g_aberrationStrength, kMinAberration, kMaxAberration);

    if (glfwGetKey(window, GLFW_KEY_SEMICOLON) == GLFW_PRESS) {
        g_bleedStrength -= kBleedAdjustPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_APOSTROPHE) == GLFW_PRESS) {
        g_bleedStrength += kBleedAdjustPerSecond * deltaTime;
    }
    g_bleedStrength = std::clamp(g_bleedStrength, kMinBleed, kMaxBleed);
    if (consumeKeyPress(window, GLFW_KEY_R, g_ragballKeyWasDown)) {
        g_player.toggleMode(world);
        // Ragball defaults to third-person (seeing the ball roll is the
        // point); Walking defaults back to first-person. V still overrides
        // either way regardless of mode.
        g_camera.setPerspective(g_player.mode() == fgp::PlayerMode::Ragball ? fgp::CameraPerspective::ThirdPerson
                                                                             : fgp::CameraPerspective::FirstPerson);
    }

    if (consumeKeyPress(window, GLFW_KEY_B, g_bKeyWasDown)) {
        hotbar.popupOpen = !hotbar.popupOpen;
    }

    static constexpr int kSlotKeys[fgp::Inventory::kHotbarSlots] = {
        GLFW_KEY_1, GLFW_KEY_2, GLFW_KEY_3, GLFW_KEY_4, GLFW_KEY_5, GLFW_KEY_6, GLFW_KEY_7, GLFW_KEY_8,
    };
    for (int i = 0; i < fgp::Inventory::kHotbarSlots; ++i) {
        if (glfwGetKey(window, kSlotKeys[i]) == GLFW_PRESS) {
            inventory.selectHotbarSlot(i);
        }
    }

    // Debug aid: T adds one of each item, for testing the hotbar/inventory
    // before milestone 5 wires up real pickup-triggered drops.
    if (consumeKeyPress(window, GLFW_KEY_T, g_debugAddItemKeyWasDown)) {
        inventory.tryAdd(fgp::ItemType::Stick);
        inventory.tryAdd(fgp::ItemType::Leaf);
        inventory.tryAdd(fgp::ItemType::Log);
    }

    g_digCooldown -= deltaTime;
    // Digging is a Walking-mode action; there's no tool/hand free to swing
    // while tucked into a ball. Also disabled while the cursor is free, and
    // on the frame that click recaptured it — that click just re-focuses
    // the window rather than aiming at anything.
    // Scoop/chup are the Unarmed slot's actions (see Inventory::isUnarmedSelected)
    // — selecting an item slot instead doesn't do anything with LMB/RMB yet,
    // the natural extension point for future tools.
    const bool canDig = !g_cursorFree && !capturedThisFrame && g_player.mode() == fgp::PlayerMode::Walking &&
                         inventory.isUnarmedSelected() && glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS;
    if (canDig) {
        if (g_digCooldown <= 0.0f) {
            const glm::vec3 origin = g_player.eyePosition();
            const glm::vec3 direction = g_player.front();

            const bool sameAnchor = g_digAnchored &&
                                     glm::distance(origin, g_digAnchorOrigin) <= kDigReanchorPositionEpsilon &&
                                     glm::dot(direction, g_digAnchorDirection) >= kDigReanchorDirectionEpsilon;
            if (!sameAnchor) {
                const auto hit = raycastSceneAndLogs(world, dynamicLogs, physicsWorld, origin, direction, kDigReachMeters);
                if (hit) {
                    g_digAnchored = true;
                    g_digAnchorOrigin = origin;
                    g_digAnchorDirection = direction;
                    if (const auto* terrainHit = std::get_if<fgp::TerrainHit>(&*hit)) {
                        const glm::vec3 hitCenter = (glm::vec3(terrainHit->voxel) + 0.5f) * fgp::kVoxelSize;
                        world.digSphere(hitCenter, kDigRadiusMeters);
                    } else if (const auto* treeHit = std::get_if<fgp::TreeHit>(&*hit)) {
                        // Foliage only (isHandDiggable rejects Wood — that's
                        // chup's job) — digTreeSphere itself already only
                        // clears Leaf voxels.
                        const glm::vec3 hitCenter =
                            treeHit->tree->rootWorld + (glm::vec3(treeHit->localVoxel) + 0.5f) * fgp::kVoxelSize;
                        const auto cleared = fgp::digTreeSphere(*treeHit->tree, hitCenter, kDigRadiusMeters);
                        if (!cleared.empty()) {
                            treeHit->tree->mesh->upload(fgp::buildTreeVoxelMesh(treeHit->tree->voxels));
                            spawnDebrisForCleared(cleared, treeHit->tree->rootWorld, kIdentityRotation, fgp::Material::Leaf);
                            spawnFoliagePickups(pickupField, world, hitCenter);
                        }
                    } else {
                        // Felled log — see Felled-log interactivity above.
                        const auto* logHit = std::get_if<LogHit>(&*hit);
                        std::fprintf(stderr, "[log-scoop] logIndex=%zu\n", logHit->logIndex);
                        const glm::vec3 hitCenter =
                            logHit->position + logHit->rotation * ((glm::vec3(logHit->localVoxel) + 0.5f) * fgp::kVoxelSize);
                        DynamicLog& log = dynamicLogs[logHit->logIndex];
                        const auto cleared =
                            fgp::digVoxelGridSphere(log.voxels, logHit->position, logHit->rotation, hitCenter, kDigRadiusMeters);
                        std::fprintf(stderr, "[log-scoop] cleared=%zu\n", cleared.size());
                        if (!cleared.empty()) {
                            spawnDebrisForCleared(cleared, logHit->position, logHit->rotation, fgp::Material::Leaf);
                            spawnFoliagePickups(pickupField, world, hitCenter);
                            if (gridIsEmpty(log.voxels)) {
                                physicsWorld.removeBody(log.body);
                                dynamicLogs.erase(dynamicLogs.begin() + static_cast<std::ptrdiff_t>(logHit->logIndex));
                            } else {
                                std::fprintf(stderr, "[log-scoop] building mesh, dims=(%d,%d,%d)\n", log.voxels.dims.x,
                                             log.voxels.dims.y, log.voxels.dims.z);
                                const auto verts = fgp::buildTreeVoxelMesh(log.voxels);
                                std::fprintf(stderr, "[log-scoop] mesh built, vertCount=%zu, uploading\n", verts.size());
                                log.mesh->upload(verts);
                                std::fprintf(stderr, "[log-scoop] uploaded\n");
                            }
                        }
                    }
                } else {
                    g_digAnchored = false;
                }
            }
            g_digCooldown = kDigTickSeconds;
        }
    } else {
        // Resetting to 0 (rather than letting the cooldown run negative)
        // stops a release-then-repress from firing a queued burst of digs.
        // Releasing also drops the anchor so the next press always starts a
        // fresh gesture.
        g_digCooldown = 0.0f;
        g_digAnchored = false;
    }

    g_chupCooldown -= deltaTime;
    const bool canChup = !g_cursorFree && !capturedThisFrame && g_player.mode() == fgp::PlayerMode::Walking &&
                          inventory.isUnarmedSelected() && glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_RIGHT) == GLFW_PRESS;
    if (canChup) {
        if (g_chupCooldown <= 0.0f) {
            const glm::vec3 origin = g_player.eyePosition();
            const glm::vec3 direction = g_player.front();

            const auto hit = raycastSceneAndLogs(world, dynamicLogs, physicsWorld, origin, direction, kChupReachMeters);
            if (const auto* treeHit = hit ? std::get_if<fgp::TreeHit>(&*hit) : nullptr) {
                fgp::TreeInstance& tree = *treeHit->tree;
                const glm::vec3 hitCenter =
                    tree.rootWorld + (glm::vec3(treeHit->localVoxel) + 0.5f) * fgp::kVoxelSize;
                // chopTree clears anything isChoppable within its disc
                // (Wood or Leaf) — harmless no-op if it landed somewhere
                // with neither (e.g. just past the canopy's edge).
                fgp::ChopResult chop =
                    fgp::chopTree(tree, hitCenter, kChupHorizontalRadiusMeters, kChupVerticalHalfThicknessMeters);
                if (!chop.clearedWoodVoxels.empty() || !chop.clearedLeafVoxels.empty()) {
                    tree.mesh->upload(fgp::buildTreeVoxelMesh(tree.voxels));
                    if (!chop.clearedWoodVoxels.empty()) {
                        spawnDebrisForCleared(chop.clearedWoodVoxels, tree.rootWorld, kIdentityRotation, fgp::Material::Wood);
                        spawnWoodPickups(pickupField, world, hitCenter);
                    }
                    if (!chop.clearedLeafVoxels.empty()) {
                        spawnDebrisForCleared(chop.clearedLeafVoxels, tree.rootWorld, kIdentityRotation, fgp::Material::Leaf);
                        spawnFoliagePickups(pickupField, world, hitCenter);
                    }
                    if (chop.severedAtLocalY && chop.severedAbove) {
                        world.recordTreeSevered(tree.treeHash, *chop.severedAtLocalY);

                        // Capsule proxy for physics (radius = trunk radius,
                        // half-height/pivot = the severed piece's own
                        // occupied-bounds center); the render mesh stays the
                        // real chipped voxel geometry. Re-basing the grid to
                        // its own pivot (rather than just shifting a copy of
                        // the render vertices) is what keeps this piece
                        // scoop/chup-interactable afterward as a DynamicLog
                        // — see the "Felled-log interactivity" comment above.
                        fgp::TreeVoxelGrid pieceVoxels = std::move(*chop.severedAbove);
                        const GridPivot pivot = computeGridPivot(pieceVoxels);
                        rebaseGridToPivot(pieceVoxels, pivot);
                        const glm::vec3 pivotLocal(0.0f, pivot.localY, 0.0f);
                        const float radiusMeters = tree.trunkRadiusVoxels * fgp::kVoxelSize;

                        std::fprintf(stderr,
                                     "[sever] severedAtLocalY=%d pieceDims=(%d,%d,%d) pieceOriginLocal=(%d,%d,%d) "
                                     "pivotShiftVoxels=%d pivotLocal=(%.3f,%.3f,%.3f) halfHeight=%.3f radius=%.3f "
                                     "spawnWorldPos=(%.3f,%.3f,%.3f)\n",
                                     *chop.severedAtLocalY, pieceVoxels.dims.x, pieceVoxels.dims.y, pieceVoxels.dims.z,
                                     pieceVoxels.originLocal.x, pieceVoxels.originLocal.y, pieceVoxels.originLocal.z,
                                     pivot.shiftVoxels, static_cast<double>(pivotLocal.x), static_cast<double>(pivotLocal.y),
                                     static_cast<double>(pivotLocal.z), static_cast<double>(pivot.halfHeightMeters),
                                     static_cast<double>(radiusMeters), static_cast<double>(tree.rootWorld.x + pivotLocal.x),
                                     static_cast<double>(tree.rootWorld.y + pivotLocal.y),
                                     static_cast<double>(tree.rootWorld.z + pivotLocal.z));

                        const JPH::BodyID logBody = physicsWorld.spawnCapsuleBody(
                            tree.rootWorld + pivotLocal, kIdentityRotation, radiusMeters, pivot.halfHeightMeters,
                            /*applyToppleImpulse=*/true);
                        std::fprintf(stderr, "[sever] spawnCapsuleBody returned invalid=%d\n", logBody.IsInvalid());
                        if (!logBody.IsInvalid()) {
                            auto logMesh = std::make_unique<fgp::ChunkMesh>();
                            logMesh->upload(fgp::buildTreeVoxelMesh(pieceVoxels)); // already pivot-centered
                            dynamicLogs.push_back(
                                DynamicLog{logBody, std::move(logMesh), std::move(pieceVoxels), radiusMeters, /*wasActive=*/true});
                            std::fprintf(stderr, "[sever] DynamicLog created, dynamicLogs.size()=%zu\n", dynamicLogs.size());
                        }
                    }
                }
            } else if (const auto* logHit = hit ? std::get_if<LogHit>(&*hit) : nullptr) {
                // Felled log — see "Felled-log interactivity" above.
                const std::size_t logIndex = logHit->logIndex;
                std::fprintf(stderr,
                             "[log-chop] logIndex=%zu dynamicLogs.size()=%zu localVoxel=(%d,%d,%d) "
                             "logPos=(%.3f,%.3f,%.3f) logRot=(%.3f,%.3f,%.3f,%.3f)\n",
                             logIndex, dynamicLogs.size(), logHit->localVoxel.x, logHit->localVoxel.y, logHit->localVoxel.z,
                             static_cast<double>(logHit->position.x), static_cast<double>(logHit->position.y),
                             static_cast<double>(logHit->position.z), static_cast<double>(logHit->rotation.x),
                             static_cast<double>(logHit->rotation.y), static_cast<double>(logHit->rotation.z),
                             static_cast<double>(logHit->rotation.w));
                DynamicLog& log = dynamicLogs[logIndex];
                std::fprintf(stderr, "[log-chop] log.voxels dims=(%d,%d,%d) originLocal=(%d,%d,%d) radiusMeters=%.3f\n",
                             log.voxels.dims.x, log.voxels.dims.y, log.voxels.dims.z, log.voxels.originLocal.x,
                             log.voxels.originLocal.y, log.voxels.originLocal.z, static_cast<double>(log.radiusMeters));
                const glm::vec3 hitCenter =
                    logHit->position + logHit->rotation * ((glm::vec3(logHit->localVoxel) + 0.5f) * fgp::kVoxelSize);
                fgp::ChopResult chop =
                    fgp::chopVoxelGrid(log.voxels, logHit->position, logHit->rotation, hitCenter,
                                        kChupHorizontalRadiusMeters, kChupVerticalHalfThicknessMeters);
                std::fprintf(stderr, "[log-chop] clearedWood=%zu clearedLeaf=%zu severed=%d\n",
                             chop.clearedWoodVoxels.size(), chop.clearedLeafVoxels.size(),
                             chop.severedAtLocalY.has_value());
                if (!chop.clearedWoodVoxels.empty() || !chop.clearedLeafVoxels.empty()) {
                    if (!chop.clearedWoodVoxels.empty()) {
                        spawnDebrisForCleared(chop.clearedWoodVoxels, logHit->position, logHit->rotation, fgp::Material::Wood);
                        spawnWoodPickups(pickupField, world, hitCenter);
                    }
                    if (!chop.clearedLeafVoxels.empty()) {
                        spawnDebrisForCleared(chop.clearedLeafVoxels, logHit->position, logHit->rotation, fgp::Material::Leaf);
                        spawnFoliagePickups(pickupField, world, hitCenter);
                    }

                    if (chop.severedAtLocalY && chop.severedAbove) {
                        // Re-severance: both halves' extents changed, so
                        // neither's old capsule fits anymore — remove it and
                        // spawn two fresh ones, reusing the exact same
                        // pivot/re-basing approach the tree->log severance
                        // above uses (this log's grid is already in a
                        // pivot-based local frame from ITS creation, so the
                        // math is identical, just sourced from the log's
                        // current transform instead of a tree's rootWorld).
                        std::fprintf(stderr, "[log-resever] entering, severedAtLocalY=%d aboveDims=(%d,%d,%d)\n",
                                     *chop.severedAtLocalY, chop.severedAbove->dims.x, chop.severedAbove->dims.y,
                                     chop.severedAbove->dims.z);
                        const float radiusMeters = log.radiusMeters;
                        physicsWorld.removeBody(log.body);

                        // A capsule's total collision length is 2*halfHeight
                        // + 2*radius (hemispherical caps beyond the
                        // cylinder) — spawning both halves flush at their
                        // true occupied-bounds centers would overlap their
                        // caps by up to 2*radiusMeters right at the cut, and
                        // Jolt would kick them apart on the first physics
                        // step. Push each pivot outward by radiusMeters
                        // (below down, above up) before rebasing so the
                        // grid/mesh/capsule all agree on a small real gap at
                        // the cut instead.
                        const int gapVoxels = static_cast<int>(std::lround(radiusMeters / fgp::kVoxelSize));

                        // "below" (remaining) piece: log.voxels was already
                        // shrunk in place by chopVoxelGrid/severVoxelGridAt.
                        GridPivot belowPivot = computeGridPivot(log.voxels);
                        belowPivot.shiftVoxels -= gapVoxels;
                        belowPivot.localY = static_cast<float>(belowPivot.shiftVoxels) * fgp::kVoxelSize;
                        const bool belowEmpty = gridIsEmpty(log.voxels);
                        JPH::BodyID belowBody;
                        if (!belowEmpty) {
                            rebaseGridToPivot(log.voxels, belowPivot);
                            belowBody = physicsWorld.spawnCapsuleBody(
                                logHit->position + logHit->rotation * glm::vec3(0.0f, belowPivot.localY, 0.0f),
                                logHit->rotation, radiusMeters, belowPivot.halfHeightMeters,
                                /*applyToppleImpulse=*/false);
                        }

                        // "above" (severed-off) piece: a brand new log.
                        fgp::TreeVoxelGrid aboveVoxels = std::move(*chop.severedAbove);
                        GridPivot abovePivot = computeGridPivot(aboveVoxels);
                        abovePivot.shiftVoxels += gapVoxels;
                        abovePivot.localY = static_cast<float>(abovePivot.shiftVoxels) * fgp::kVoxelSize;
                        const bool aboveEmpty = gridIsEmpty(aboveVoxels);
                        JPH::BodyID aboveBody;
                        if (!aboveEmpty) {
                            rebaseGridToPivot(aboveVoxels, abovePivot);
                            aboveBody = physicsWorld.spawnCapsuleBody(
                                logHit->position + logHit->rotation * glm::vec3(0.0f, abovePivot.localY, 0.0f),
                                logHit->rotation, radiusMeters, abovePivot.halfHeightMeters,
                                /*applyToppleImpulse=*/false);
                        }

                        std::fprintf(stderr,
                                     "[log-resever] belowEmpty=%d belowInvalid=%d aboveEmpty=%d aboveInvalid=%d "
                                     "gapVoxels=%d\n",
                                     belowEmpty, belowBody.IsInvalid(), aboveEmpty, aboveBody.IsInvalid(), gapVoxels);
                        if (!belowEmpty && !belowBody.IsInvalid()) {
                            log.body = belowBody;
                            log.mesh->upload(fgp::buildTreeVoxelMesh(log.voxels));
                            log.wasActive = true;
                            // Grid/pivot/body just changed — re-earn the snap
                            // rather than keeping a stale one from before the
                            // re-cut (see DynamicLog::snapped).
                            log.snapped = false;
                        }
                        if (!aboveEmpty && !aboveBody.IsInvalid()) {
                            auto aboveMesh = std::make_unique<fgp::ChunkMesh>();
                            aboveMesh->upload(fgp::buildTreeVoxelMesh(aboveVoxels));
                            dynamicLogs.push_back(DynamicLog{aboveBody, std::move(aboveMesh), std::move(aboveVoxels),
                                                              radiusMeters, /*wasActive=*/true});
                        } else if (!aboveBody.IsInvalid()) {
                            physicsWorld.removeBody(aboveBody);
                        }
                        std::fprintf(stderr, "[log-resever] done, dynamicLogs.size()=%zu\n", dynamicLogs.size());
                        // dynamicLogs may have reallocated via push_back above, but that only
                        // ever appends — logIndex still names the same "below" slot afterward.
                        if (belowEmpty || belowBody.IsInvalid()) {
                            if (!belowBody.IsInvalid()) {
                                physicsWorld.removeBody(belowBody);
                            }
                            dynamicLogs.erase(dynamicLogs.begin() + static_cast<std::ptrdiff_t>(logIndex));
                        }
                    } else if (gridIsEmpty(log.voxels)) {
                        // Chopped away the last of it without a "no wood in
                        // this band" trigger (e.g. its last few Leaf voxels).
                        physicsWorld.removeBody(log.body);
                        dynamicLogs.erase(dynamicLogs.begin() + static_cast<std::ptrdiff_t>(logIndex));
                    } else {
                        std::fprintf(stderr, "[log-chop] building mesh, dims=(%d,%d,%d)\n", log.voxels.dims.x,
                                     log.voxels.dims.y, log.voxels.dims.z);
                        const auto verts = fgp::buildTreeVoxelMesh(log.voxels);
                        std::fprintf(stderr, "[log-chop] mesh built, vertCount=%zu, uploading\n", verts.size());
                        log.mesh->upload(verts);
                        std::fprintf(stderr, "[log-chop] uploaded\n");
                    }
                }
            }
            g_chupCooldown = kChupTickSeconds;
        }
    } else {
        g_chupCooldown = 0.0f;
    }
}

int run() {
    if (!glfwInit()) {
        std::fprintf(stderr, "failed to initialize GLFW\n");
        return EXIT_FAILURE;
    }

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#endif

    // Exclusive fullscreen at the desktop's native resolution — sidesteps
    // window-manager edge-drag resizing entirely (its hit region proved too
    // fiddly to use, on top of the cursor-capture interactions above).
    GLFWmonitor* monitor = glfwGetPrimaryMonitor();
    const GLFWvidmode* mode = monitor ? glfwGetVideoMode(monitor) : nullptr;
    const int windowWidth = mode ? mode->width : kInitialWidth;
    const int windowHeight = mode ? mode->height : kInitialHeight;
    if (mode) {
        glfwWindowHint(GLFW_RED_BITS, mode->redBits);
        glfwWindowHint(GLFW_GREEN_BITS, mode->greenBits);
        glfwWindowHint(GLFW_BLUE_BITS, mode->blueBits);
        glfwWindowHint(GLFW_REFRESH_RATE, mode->refreshRate);
    }

    GLFWwindow* window = glfwCreateWindow(windowWidth, windowHeight, "fatguyphysics", monitor, nullptr);
    if (!window) {
        std::fprintf(stderr, "failed to create window\n");
        glfwTerminate();
        return EXIT_FAILURE;
    }

    glfwMakeContextCurrent(window);
    // Starts free/visible (see g_cursorFree) — click into the viewport to
    // capture it for mouselook.
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
    // Reads relative motion straight from the input device instead of
    // GLFW's default warp-and-diff virtualization for disabled-cursor mode
    // — more accurate in general. No-op whenever cursor mode isn't
    // DISABLED, so it's safe to set once up front rather than toggling it
    // alongside every GLFW_CURSOR change.
    if (glfwRawMouseMotionSupported()) {
        glfwSetInputMode(window, GLFW_RAW_MOUSE_MOTION, GLFW_TRUE);
    }
    glfwSetFramebufferSizeCallback(window, framebufferSizeCallback);
    glfwSetCursorPosCallback(window, cursorPosCallback);
#if defined(__linux__)
    // See setX11AutoRepeat's comment above. Exclusive fullscreen at launch
    // means this window has focus immediately, so turn it off right away
    // rather than waiting for a focus event that's already happened.
    glfwSetWindowFocusCallback(window, windowFocusCallback);
    setX11AutoRepeat(false);
#endif

    if (!gladLoadGL(reinterpret_cast<GLADloadfunc>(glfwGetProcAddress))) {
        std::fprintf(stderr, "failed to load OpenGL via glad\n");
        glfwTerminate();
        return EXIT_FAILURE;
    }

    glEnable(GL_DEPTH_TEST);
    glEnable(GL_CULL_FACE);

    // Scoped so every GL-owning object below is destroyed (freeing VAOs,
    // VBOs, textures, shader programs) before glfwTerminate() destroys the
    // context those destructors need to call into.
    {
        const std::filesystem::path shaderDir = fgp::executableDir() / "assets" / "shaders";
        fgp::Shader shader(shaderDir / "basic.vert", shaderDir / "basic.frag");
        fgp::Shader crosshairShader(shaderDir / "crosshair.vert", shaderDir / "crosshair.frag");
        fgp::Shader postProcessShader(shaderDir / "postprocess.vert", shaderDir / "postprocess.frag");
        fgp::Shader uiIconShader(shaderDir / "ui_icon.vert", shaderDir / "ui_icon.frag");
        fgp::PostProcess postProcess;
        fgp::Crosshair crosshair;
        fgp::HudText hudFov;
        fgp::HudText hudFps;
        fgp::HudText hudWorst;
        fgp::HudText hudDist;
        fgp::HudText hudCa;
        fgp::HudText hudBleed;

        fgp::Texture cobbleTexture(fgp::executableDir() / "assets" / "textures" / "cobble.png", fgp::TextureFilter::Tile);
        fgp::Texture whiteTexture(fgp::executableDir() / "assets" / "textures" / "white.png", fgp::TextureFilter::Tile);
        fgp::Texture bushTexture(fgp::executableDir() / "assets" / "billboard" / "bush.png", fgp::TextureFilter::Tile);
        shader.use();
        shader.setInt("uTexture", 0);

        // Hotbar icons — assets/icons/*.png, user-authored. log.png isn't
        // made yet (no Log item drops until milestone 5-7), so that one
        // load is allowed to fail; the slot just draws blank until it
        // exists (Hotbar::drawSlot skips a nullptr icon).
        const std::filesystem::path iconsDir = fgp::executableDir() / "assets" / "icons";
        fgp::Texture unarmedIcon(iconsDir / "unarmed.png", fgp::TextureFilter::Icon);
        fgp::Texture stickIcon(iconsDir / "stick.png", fgp::TextureFilter::Icon);
        fgp::Texture leafIcon(iconsDir / "leaf.png", fgp::TextureFilter::Icon);
        std::unique_ptr<fgp::Texture> logIcon;
        try {
            logIcon = std::make_unique<fgp::Texture>(iconsDir / "log.png", fgp::TextureFilter::Icon);
        } catch (const std::exception&) {
            logIcon.reset();
        }
        const std::array<const fgp::Texture*, fgp::kItemTypeCount> itemIcons = {&stickIcon, &leafIcon, logIcon.get()};

        fgp::Inventory inventory;
        fgp::Hotbar hotbar;
        fgp::PickupField pickupField;

        fgp::World world(/*seed=*/1337);
        fgp::PhysicsWorld physicsWorld(world);

        // Owns GL objects (ChunkMesh) reached transitively — must be
        // destroyed before glfwTerminate() tears down the GL context, so
        // this lives here (run()'s scope) rather than as a global. See
        // DynamicLog's comment.
        std::vector<DynamicLog> dynamicLogs;

        fgp::ChunkMesh debugBoxMesh;
        debugBoxMesh.upload(buildDebugBoxMesh(kDebugBoxHalfExtents, kDebugBoxColor));

        // Debris meshes: one shared small cube per source material (Wood
        // for chup, Leaf for scoop-on-foliage) — see Debris/spawnDebris.
        fgp::ChunkMesh debrisWoodMesh;
        debrisWoodMesh.upload(buildDebugBoxMesh(glm::vec3(kDebrisHalfExtent), fgp::materialColor(fgp::Material::Wood)));
        fgp::ChunkMesh debrisLeafMesh;
        debrisLeafMesh.upload(buildDebugBoxMesh(glm::vec3(kDebrisHalfExtent), fgp::materialColor(fgp::Material::Leaf)));
        // First syncChunkBodies (below, before the main loop starts) hasn't
        // run yet, so terrain bodies don't exist under this spawn point on
        // this exact frame — the drop height gives it time to appear before
        // the box would otherwise reach the ground.
        physicsWorld.syncChunkBodies(g_player.feetPosition());
        const JPH::BodyID debugBoxBody =
            physicsWorld.spawnDebugBoxBody(g_player.feetPosition() + kDebugBoxSpawnOffset, kDebugBoxHalfExtents);

        // Player body — see PlayerMesh.hpp. Uploaded once; a unit-radius,
        // origin-centered mesh is reused every frame via uModel (translate
        // * rotate * scale), same as chunks reuse their mesh via translate.
        // Loads assets/meshes/playermodel_v1.glb if present, otherwise
        // falls back to the placeholder sphere. Same body doubles as the
        // ragball — the model has no animation yet, so both modes just
        // reuse this static mesh with the rotation driven by physics.
        fgp::ChunkMesh playerMesh;
        const std::filesystem::path playerMeshPath =
            fgp::executableDir() / "assets" / "meshes" / "playermodel_v1.glb";
        // mirrorAxis=2 (Z): the source mesh was authored with an unapplied
        // Mirror modifier, so only half the body is in the file. Blender's
        // Y (its mirror axis) becomes glTF/local Z under the standard
        // Blender->glTF Z-up-to-Y-up axis conversion.
        if (auto loadedMesh = fgp::loadPlayerMeshFromGltf(playerMeshPath, kPlayerBodyColor, /*mirrorAxis=*/2)) {
            playerMesh.upload(*loadedMesh);
        } else {
            playerMesh.upload(fgp::buildPlayerSphereMesh(kPlayerBodyColor));
        }

        float lastFrameTime = static_cast<float>(glfwGetTime());
        float accumulator = 0.0f;

        while (!glfwWindowShouldClose(window)) {
            const float currentFrameTime = static_cast<float>(glfwGetTime());
            const float rawFrameTime = currentFrameTime - lastFrameTime;
            const float frameTime = std::min(rawFrameTime, kMaxFrameTime);
            lastFrameTime = currentFrameTime;

            if (frameTime > 0.0f) {
                const float instantFps = 1.0f / frameTime;
                g_fpsSmoothed = g_fpsSmoothed <= 0.0f ? instantFps
                                                       : glm::mix(g_fpsSmoothed, instantFps, kFpsSmoothing);
            }

            g_worstFrameMsInWindow = std::max(g_worstFrameMsInWindow, rawFrameTime * 1000.0f);
            g_worstFrameWindowElapsed += frameTime;
            if (g_worstFrameWindowElapsed >= 1.0f) {
                g_worstFrameMsDisplay = g_worstFrameMsInWindow;
                g_worstFrameMsInWindow = 0.0f;
                g_worstFrameWindowElapsed = 0.0f;
            }

            g_currentTime = currentFrameTime;
            updateDebris(frameTime);
            pickupField.update(frameTime, g_currentTime, g_player.feetPosition(), inventory);

            processNonMovementInput(window, frameTime, world, physicsWorld, dynamicLogs, inventory, hotbar, pickupField);

            // See runLogSettlePass's own comment: must run here — after
            // processNonMovementInput (the only place dynamicLogs' size/
            // order changes) and before world.update/the fixed-substep loop
            // (which reads the registry this rebuilds via player collision).
            runLogSettlePass(dynamicLogs, world, physicsWorld, pickupField);

            // Apply this frame's accumulated look delta exactly once, before
            // anything reads front_/right_ (movement input below, then
            // physics) — see g_lookDelta's comment.
            g_player.look(g_lookDelta.x, g_lookDelta.y);
            g_lookDelta = glm::vec2(0.0f);

            const fgp::PlayerInput input = gatherPlayerInput(window);

            // Stream chunks around the player before stepping physics, so
            // this frame's collision queries see terrain rather than the
            // "unloaded" default.
            world.update(g_player.feetPosition());
            physicsWorld.syncChunkBodies(g_player.feetPosition());

            accumulator += frameTime;
            int substeps = 0;
            while (accumulator >= kFixedTimestep && substeps < kMaxSubsteps) {
                g_player.update(input, kFixedTimestep, world);
                physicsWorld.step(kFixedTimestep);
                accumulator -= kFixedTimestep;
                ++substeps;
            }
            if (substeps == kMaxSubsteps) {
                // Dropped time after a huge spike rather than spiraling.
                accumulator = 0.0f;
            }

            g_camera.sync(g_player, world);

            int width = 0;
            int height = 0;
            glfwGetFramebufferSize(window, &width, &height);
            const float aspect = height > 0 ? static_cast<float>(width) / static_cast<float>(height) : 1.0f;

            // The 3D scene renders into an offscreen target so the
            // chromatic-aberration/color-bleed composite pass below can
            // distort it as a whole; screen-space UI (crosshair, HUD) draws
            // straight to the default framebuffer afterwards, undistorted.
            postProcess.begin(width, height);

            glClearColor(0.53f, 0.72f, 0.86f, 1.0f);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

            const glm::mat4 view = g_camera.viewMatrix();
            const glm::mat4 projection = glm::perspective(glm::radians(g_camera.fovDegrees), aspect, 0.1f, 100.0f);

            shader.use();
            shader.setMat4("uView", view);
            shader.setMat4("uProjection", projection);

            cobbleTexture.bind(0);
            world.draw(shader);

            // Cross-quad billboards (see Vegetation.cpp): each is only
            // wound for one side, same as the placeholder player mesh below,
            // so face culling has to be off for both sides to render.
            bushTexture.bind(0);
            glDisable(GL_CULL_FACE);
            world.drawBushes(shader);
            glEnable(GL_CULL_FACE);

            // Milestone-1 physics smoke test box — see buildDebugBoxMesh.
            {
                shader.setMat4("uModel", physicsWorld.bodyTransform(debugBoxBody));
                whiteTexture.bind(0);
                glDisable(GL_CULL_FACE);
                debugBoxMesh.draw();
                glEnable(GL_CULL_FACE);
            }

            // Debris — see Debris/spawnDebris. Own color baked per mesh
            // (whiteTexture just lets the vertex color show through).
            {
                whiteTexture.bind(0);
                glDisable(GL_CULL_FACE);
                for (const Debris& d : g_debris) {
                    shader.setMat4("uModel", glm::translate(glm::mat4(1.0f), d.position));
                    (d.material == fgp::Material::Wood ? debrisWoodMesh : debrisLeafMesh).draw();
                }
                glEnable(GL_CULL_FACE);
            }

            // Severed trunks — see DynamicLog. Correctly wound (same
            // emitBoxFaces convention as terrain/canopy), so no need to
            // disable face culling the way the debug box/debris do.
            {
                cobbleTexture.bind(0);
                for (const DynamicLog& log : dynamicLogs) {
                    shader.setMat4("uModel", physicsWorld.bodyTransform(log.body));
                    log.mesh->draw();
                }
            }

            // Item drops — see PickupField. Reuses the hotbar's icon
            // textures as world-space sprites, one asset for both.
            pickupField.draw(shader, itemIcons, g_camera.position(), g_currentTime);

            if (g_camera.perspective() == fgp::CameraPerspective::ThirdPerson) {
                const glm::mat4 model = glm::translate(glm::mat4(1.0f), g_player.bodyCenter()) *
                                         glm::mat4_cast(g_player.bodyOrientation()) *
                                         glm::scale(glm::mat4(1.0f), glm::vec3(g_player.bodyRadius()));
                shader.setMat4("uModel", model);
                whiteTexture.bind(0);
                // Placeholder art only — not worth hand-verifying winding for.
                glDisable(GL_CULL_FACE);
                playerMesh.draw();
                glEnable(GL_CULL_FACE);
            }

            // Composite the offscreen scene back to the default framebuffer
            // with chromatic aberration + color bleed applied, before any
            // undistorted screen-space UI draws on top of it.
            postProcess.end(postProcessShader, g_aberrationStrength, g_bleedStrength);

            glDisable(GL_DEPTH_TEST);
            // HudText's screen-space quads aren't wound consistently with GL's
            // default CCW front face, so without this they get silently
            // back-face culled (Crosshair draws GL_LINES, which face culling
            // never touches, so it was rendering fine while this wasn't).
            glDisable(GL_CULL_FACE);
            crosshair.draw(crosshairShader, width, height);

            const auto hudHit = fgp::raycastVoxel(world, g_player.eyePosition(), g_player.front(), kHudRaycastReachMeters);
            std::string distText = "DIST:--";
            if (hudHit) {
                const glm::vec3 hitCenter = (glm::vec3(*hudHit) + 0.5f) * fgp::kVoxelSize;
                const int distMeters = static_cast<int>(std::lround(glm::distance(g_player.eyePosition(), hitCenter)));
                distText = "DIST:" + std::to_string(distMeters);
            }

            const std::string fovText = "FOV:" + std::to_string(static_cast<int>(std::lround(g_camera.fovDegrees)));
            const std::string fpsText = "FPS:" + std::to_string(static_cast<int>(std::lround(g_fpsSmoothed)));
            const std::string worstText = "WORST:" + std::to_string(static_cast<int>(std::lround(g_worstFrameMsDisplay)));
            // CA/bleed are fractional (see their ranges above), so scale to
            // whole numbers for this digits-only-friendly HUD font.
            const std::string caText = "CA:" + std::to_string(static_cast<int>(std::lround(g_aberrationStrength * 1000.0f)));
            const std::string bleedText = "BLEED:" + std::to_string(static_cast<int>(std::lround(g_bleedStrength * 100.0f)));
            hudFov.draw(crosshairShader, fovText, width, height, kHudMarginX, kHudMarginX);
            hudFps.draw(crosshairShader, fpsText, width, height, kHudMarginX, kHudMarginX + kHudLineHeight);
            hudWorst.draw(crosshairShader, worstText, width, height, kHudMarginX, kHudMarginX + 2 * kHudLineHeight);
            hudDist.draw(crosshairShader, distText, width, height, kHudMarginX, kHudMarginX + 3 * kHudLineHeight);
            hudCa.draw(crosshairShader, caText, width, height, kHudMarginX, kHudMarginX + 4 * kHudLineHeight);
            hudBleed.draw(crosshairShader, bleedText, width, height, kHudMarginX, kHudMarginX + 5 * kHudLineHeight);
            hotbar.draw(uiIconShader, inventory, whiteTexture, unarmedIcon, itemIcons, crosshairShader, width, height);
            glEnable(GL_CULL_FACE);
            glEnable(GL_DEPTH_TEST);

            glfwSwapBuffers(window);
            glfwPollEvents();
        }
    }

#if defined(__linux__)
    // Safety net in case the window closed without ever losing focus
    // (the normal path — see windowFocusCallback).
    setX11AutoRepeat(true);
#endif
    glfwTerminate();
    return EXIT_SUCCESS;
}

} // namespace

int main() {
    try {
        return run();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "fatal error: %s\n", e.what());
        return EXIT_FAILURE;
    }
}
