#pragma once

#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
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

    // Removes hand-diggable material within radiusMeters of centerWorld,
    // skipping voxels in unloaded chunks (never force-loads), and re-meshes
    // only the chunks actually touched.
    void digSphere(glm::vec3 centerWorld, float radiusMeters);

private:
    struct LoadedChunk {
        std::unique_ptr<Chunk> chunk;
        std::unique_ptr<ChunkMesh> mesh;
        std::vector<VegetationInstance> trees;
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
