#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include "Chunk.hpp"
#include "ChunkMesh.hpp"
#include "TerrainGenerator.hpp"
#include "Vegetation.hpp"
#include "../Shader.hpp"

namespace fgp {

// One sleeping, snap-on-sleep felled log's grid, registered with World so
// collision/raycasts can treat it as a first-class solid surface alongside
// terrain. See isSolidIncludingSnappedLogs's doc comment for the load-
// bearing caveat about what this does and doesn't cover.
struct SnappedSolidGrid {
    const TreeVoxelGrid* grid;   // owned by the DynamicLog that registered it (main.cpp);
                                  // valid only until the next setSnappedSolidGrids call,
                                  // which main.cpp issues fresh every frame.
    glm::ivec3 worldVoxelOrigin; // world-voxel coord of the grid's tree-local (0,0,0)
    glm::ivec3 axisX, axisY, axisZ; // columns of the snapped rotation matrix; each is
                                     // exactly one of (+-1,0,0)/(0,+-1,0)/(0,0,+-1) — an
                                     // exact integer signed permutation, never re-derived
                                     // from float quaternion math on this path.
    // A voxel is a unit CUBE [local, local+1), not a point — under a signed
    // permutation with a -1 entry, that cube's min corner in world space is
    // NOT origin + R*local, it's off by one on every axis R flips (rotate
    // the cube [0,1) 180 degrees about an axis and its world-space min
    // corner moves to -1, not 0). negMask is that correction, precomputed
    // once when the rotation is snapped: one componentwise vector with -1
    // on every world axis some local axis maps to with a negative sign, 0
    // otherwise. Both directions need it: worldVoxel = origin + R*local +
    // negMask, and local = R^T * (worldVoxel - origin - negMask).
    glm::ivec3 negMask;
};

// Streams chunks in a horizontal radius around a world-space position,
// generating + meshing + uploading new ones and dropping ones that fall
// out of range.
//
// The initial full-radius load (first update() call) runs synchronously,
// since main.cpp streams chunks before stepping physics and there's no
// previously-loaded terrain to show while an async load catches up. Every
// load after that — the crescent of newly-desired chunks when the player
// crosses a chunk boundary — is handed to a worker thread pool: workers run
// terrain generation, meshing, and vegetation placement (all pure CPU work,
// no GL calls), and update() drains a capped number of finished results
// into real GPU meshes each frame. Only GL calls (ChunkMesh construction/
// upload) happen on the main thread; workers never touch loaded_.
//
// Vertical range is a fixed band rather than streamed: Phase 1's
// heightmap generator only ever produces terrain within a known,
// bounded Y range, so there's nothing above/below it to stream in.
// That stops being true once caves/full 3D density generation exist.
class World {
public:
    explicit World(int seed, int loadRadiusChunks = 6);
    ~World();

    // Worker threads capture `this`; copying or moving a World out from
    // under them would leave those threads pointing at a dead/relocated
    // object.
    World(const World&) = delete;
    World& operator=(const World&) = delete;
    World(World&&) = delete;
    World& operator=(World&&) = delete;

    void update(glm::vec3 cameraWorldPos);
    // Draws terrain plus trees (both use whatever texture unit 0 is bound to
    // when called, per main.cpp's convention of binding cobbleTexture once
    // for all opaque world geometry).
    void draw(const Shader& shader) const;
    // Bushes are alpha-cutout billboards using a different texture, so
    // they're a separate draw call — the caller binds the bush texture (and
    // disables face culling, same as the placeholder player mesh) around it.
    void drawBushes(const Shader& shader) const;

    int surfaceHeightVoxels(int worldX, int worldZ) const { return generator_.surfaceHeight(worldX, worldZ); }

    // Air for voxels in unloaded chunks, not just voxels that are actually Air.
    Material materialAt(glm::ivec3 worldVoxel) const;

    // Replaces the whole registered snap-on-sleep log list. Called once per
    // frame by main.cpp's settle pass (see DynamicLog/runLogSettlePass) —
    // cheap, since there are only ever a handful of sleeping logs at once.
    void setSnappedSolidGrids(std::vector<SnappedSolidGrid> grids) { snappedLogGrids_ = std::move(grids); }

    // TEMPORARY AND UNACCEPTABLE STOPGAP — do not treat this as the real
    // solution to "the player should be able to stand on physics objects."
    // This is isSolid(materialAt(...)) plus a lookup against whatever felled
    // logs happened to snap onto the axis-aligned world voxel lattice when
    // they fell asleep (see main.cpp's snap-on-sleep machinery). It only
    // ever makes a cluster walkable/solid if its rest pose rounds cleanly
    // onto one of the 24 cube-aligned orientations AND a lattice-aligned
    // position clear of existing solids — a genuine off-axis tilt, a log
    // resting on a real slope, mid-tumble physics, or literally any other
    // kind of rigid debris gets none of this and stays a ghost the player
    // falls straight through. That is not a corner case to shrug off: this
    // is a physics game, and the player should eventually be able to walk
    // on all sorts of crap, not just the lucky subset that happens to land
    // square with the world grid. The real fix is generalizing player
    // collision (sweepAabb/sweepSphere/aabbOverlapsSolid in Collision.cpp)
    // to test against arbitrary oriented rigid-body voxel geometry directly,
    // instead of requiring lattice alignment as a precondition for a voxel
    // cluster to be steppable at all. Don't extend this function with more
    // special cases — replace the mechanism.
    bool isSolidIncludingSnappedLogs(glm::ivec3 worldVoxel) const;

    // Removes hand-diggable material within radiusMeters of centerWorld,
    // skipping voxels in unloaded chunks (never force-loads), and re-meshes
    // only the chunks actually touched.
    void digSphere(glm::vec3 centerWorld, float radiusMeters);

    bool isChunkLoaded(ChunkCoord coord) const { return loaded_.find(coord) != loaded_.end(); }

    // Chunk-local (meters, matches Chunk::worldOrigin()'s translation
    // convention), non-indexed triangle list — the same data already
    // uploaded to GPU for rendering, retained on the CPU side so
    // PhysicsWorld can build a static collision shape from it without
    // re-running the mesher. Returns nullptr if coord isn't loaded.
    const std::vector<Vertex>* chunkMeshVertices(ChunkCoord coord) const;

    // Coords whose terrain mesh changed (via digSphere) since the last call,
    // then cleared — lets PhysicsWorld know which chunk collision shapes
    // need rebuilding without polling every loaded chunk every frame.
    std::vector<ChunkCoord> takeDirtyTerrainChunks();

    // Tree instances (trunks/canopies with real per-voxel hit-testing — see
    // TreeVoxels.hpp) in currently-loaded chunks within radiusMeters of
    // worldPos, for scene-raycast broad-phase (see voxel/SceneRaycast.hpp).
    // Pointers are only valid until the next update() call, which can
    // unload the chunk they belong to.
    std::vector<TreeInstance*> treesNear(glm::vec3 worldPos, float radiusMeters);

    // Records that a tree (identified by generateVegetation's placement
    // hash) was chup-severed at local Y severLocalY, so a chunk that
    // streams out and back in regenerates a stump instead of an intact
    // tree. Thread-safe: the main thread calls recordTreeSevered after a
    // chup severance, worker threads call treeSeveredBand (via
    // generateVegetation's severedLookup) while generating other chunks
    // concurrently.
    void recordTreeSevered(std::uint32_t treeHash, int severLocalY);
    std::optional<int> treeSeveredBand(std::uint32_t treeHash) const;

private:
    struct LoadedChunk {
        std::unique_ptr<Chunk> chunk;
        std::unique_ptr<ChunkMesh> mesh;
        std::vector<Vertex> meshVertices;
        std::vector<TreeInstance> trees;
        std::vector<VegetationInstance> bushes;
    };

    // Everything a worker thread produces for one chunk: CPU data only, no
    // GL objects, so it's safe to build off the main thread and hand back
    // across the result queue.
    struct ChunkLoadResult {
        ChunkCoord coord;
        std::unique_ptr<Chunk> chunk;
        std::vector<Vertex> meshVertices;
        VegetationPlacementBatch vegetation;
    };

    static constexpr int kVerticalChunkMin = 0;
    static constexpr int kVerticalChunkMax = 3; // covers generator's baseHeight_ +/- amplitude_ with margin

    // Caps GL object creation per frame (chunk mesh + up to one vegetation
    // mesh per chunk today) so a burst of finished worker results — e.g. the
    // player sprinting across several chunk boundaries in one frame — can't
    // dump a frame's worth of uploads on the main thread the same way the
    // old fully-synchronous path used to. Leftover results just wait for the
    // next frame's drain.
    static constexpr int kMaxMeshUploadsPerFrame = 4;

    // Pure CPU work (terrain gen, meshing, vegetation placement) — reads
    // only generator_/seed_, which are fixed after construction, so this is
    // safe to call concurrently from multiple worker threads.
    ChunkLoadResult buildChunkLoadResult(ChunkCoord coord) const;

    // Turns a ChunkLoadResult into GL objects and inserts it into loaded_.
    // Main-thread only.
    void finalizeResult(ChunkLoadResult&& result);

    // Queues coord for background loading; must not already be loaded or
    // in-flight. Main-thread only (mutates inFlight_).
    void submitJob(ChunkCoord coord);

    // Uploads up to kMaxMeshUploadsPerFrame-worth of finished results.
    // Main-thread only. Must run every frame, not just on chunk-boundary
    // crossings, or finished chunks sit in the queue until the next
    // crossing happens to occur.
    void drainCompleted();

    void workerLoop();

    TerrainGenerator generator_;
    int seed_;
    int loadRadiusChunks_;
    std::unordered_map<ChunkCoord, LoadedChunk, ChunkCoordHash> loaded_;
    bool hasCenter_ = false;
    int centerX_ = 0;
    int centerZ_ = 0;

    // Populated by digSphere, drained by takeDirtyTerrainChunks().
    std::vector<ChunkCoord> dirtyTerrainChunks_;

    // treeHash -> severed local Y. Guards against concurrent access from
    // worker threads generating other chunks (read, via treeSeveredBand)
    // while the main thread records a fresh severance (write). Rare
    // events on both sides (a chup severance, a chunk load), so a plain
    // mutex is plenty — no need for anything fancier.
    mutable std::mutex treeEditsMutex_;
    std::unordered_map<std::uint32_t, int> treeEdits_;

    // See setSnappedSolidGrids/isSolidIncludingSnappedLogs. Rebuilt from
    // scratch every frame by main.cpp — never mutated incrementally, so
    // there's no stale-pointer risk from a DynamicLog being erased/
    // re-severed between frames.
    std::vector<SnappedSolidGrid> snappedLogGrids_;

    // Coords the current center wants loaded; drainCompleted() checks
    // results against this so a chunk that finishes generating after the
    // player has already moved away gets discarded instead of uploaded.
    std::unordered_set<ChunkCoord, ChunkCoordHash> desired_;
    // Coords already submitted to a worker but not yet drained, so update()
    // never double-submits the same coord while it's mid-flight.
    std::unordered_set<ChunkCoord, ChunkCoordHash> inFlight_;

    std::vector<std::thread> workers_;
    std::mutex jobMutex_;
    std::condition_variable jobCv_;
    std::deque<ChunkCoord> jobQueue_;
    bool stop_ = false;

    std::mutex resultMutex_;
    std::deque<ChunkLoadResult> results_;
};

} // namespace fgp
