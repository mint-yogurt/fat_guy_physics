#include "World.hpp"

#include <algorithm>
#include <cmath>

#include <glm/gtc/matrix_transform.hpp>

#include "ChunkMesher.hpp"

namespace fgp {

World::World(int seed, int loadRadiusChunks) : generator_(seed), seed_(seed), loadRadiusChunks_(loadRadiusChunks) {
    const unsigned int hw = std::thread::hardware_concurrency();
    const int workerCount = std::max(1, static_cast<int>(hw) - 1);
    workers_.reserve(static_cast<std::size_t>(workerCount));
    for (int i = 0; i < workerCount; ++i) {
        workers_.emplace_back([this] { workerLoop(); });
    }
}

World::~World() {
    {
        std::lock_guard<std::mutex> lock(jobMutex_);
        stop_ = true;
    }
    jobCv_.notify_all();
    for (std::thread& worker : workers_) {
        worker.join();
    }
}

World::ChunkLoadResult World::buildChunkLoadResult(ChunkCoord coord) const {
    auto chunk = std::make_unique<Chunk>(coord);
    generator_.generate(*chunk);
    std::vector<Vertex> meshVertices = buildChunkMesh(*chunk);
    VegetationPlacementBatch vegetation = generateVegetation(generator_, coord, seed_);
    return ChunkLoadResult{coord, std::move(chunk), std::move(meshVertices), std::move(vegetation)};
}

void World::finalizeResult(ChunkLoadResult&& result) {
    auto mesh = std::make_unique<ChunkMesh>();
    mesh->upload(result.meshVertices);

    std::vector<VegetationInstance> trees;
    trees.reserve(result.vegetation.trees.size());
    for (VegetationPlacement& placement : result.vegetation.trees) {
        auto instanceMesh = std::make_unique<ChunkMesh>();
        instanceMesh->upload(placement.vertices);
        trees.push_back(VegetationInstance{placement.origin, std::move(instanceMesh)});
    }

    std::vector<VegetationInstance> bushes;
    bushes.reserve(result.vegetation.bushes.size());
    for (VegetationPlacement& placement : result.vegetation.bushes) {
        auto instanceMesh = std::make_unique<ChunkMesh>();
        instanceMesh->upload(placement.vertices);
        bushes.push_back(VegetationInstance{placement.origin, std::move(instanceMesh)});
    }

    loaded_[result.coord] = LoadedChunk{std::move(result.chunk), std::move(mesh), std::move(trees), std::move(bushes)};
}

void World::submitJob(ChunkCoord coord) {
    inFlight_.insert(coord);
    {
        std::lock_guard<std::mutex> lock(jobMutex_);
        jobQueue_.push_back(coord);
    }
    jobCv_.notify_one();
}

void World::workerLoop() {
    while (true) {
        ChunkCoord coord;
        {
            std::unique_lock<std::mutex> lock(jobMutex_);
            jobCv_.wait(lock, [this] { return stop_ || !jobQueue_.empty(); });
            if (stop_) {
                // Exiting: bail immediately rather than draining whatever's
                // still queued — nobody needs those results anymore, and
                // waiting for them would stall shutdown.
                return;
            }
            coord = jobQueue_.front();
            jobQueue_.pop_front();
        }

        ChunkLoadResult result = buildChunkLoadResult(coord);

        std::lock_guard<std::mutex> lock(resultMutex_);
        results_.push_back(std::move(result));
    }
}

void World::drainCompleted() {
    int budget = kMaxMeshUploadsPerFrame;
    while (budget > 0) {
        ChunkLoadResult result;
        {
            std::lock_guard<std::mutex> lock(resultMutex_);
            if (results_.empty()) {
                return;
            }
            result = std::move(results_.front());
            results_.pop_front();
        }

        inFlight_.erase(result.coord);
        if (desired_.find(result.coord) == desired_.end()) {
            // Player moved away from this coord before the worker finished
            // it — drop it rather than uploading terrain nobody needs.
            continue;
        }

        const int meshCount =
            1 + static_cast<int>(result.vegetation.trees.size()) + static_cast<int>(result.vegetation.bushes.size());
        finalizeResult(std::move(result));
        budget -= meshCount;
    }
}

void World::update(glm::vec3 cameraWorldPos) {
    // Must run every frame regardless of whether the chunk center moved —
    // otherwise finished background loads sit in the queue until the next
    // boundary crossing and the world looks like it stopped streaming.
    drainCompleted();

    const float chunkWorldSize = static_cast<float>(kChunkSize) * kVoxelSize;
    const int centerX = static_cast<int>(std::floor(cameraWorldPos.x / chunkWorldSize));
    const int centerZ = static_cast<int>(std::floor(cameraWorldPos.z / chunkWorldSize));

    if (hasCenter_ && centerX == centerX_ && centerZ == centerZ_) {
        return;
    }
    const bool isInitialLoad = !hasCenter_;
    hasCenter_ = true;
    centerX_ = centerX;
    centerZ_ = centerZ;

    desired_.clear();
    const int radiusSq = loadRadiusChunks_ * loadRadiusChunks_;
    for (int dx = -loadRadiusChunks_; dx <= loadRadiusChunks_; ++dx) {
        for (int dz = -loadRadiusChunks_; dz <= loadRadiusChunks_; ++dz) {
            if (dx * dx + dz * dz > radiusSq) {
                continue;
            }
            for (int cy = kVerticalChunkMin; cy <= kVerticalChunkMax; ++cy) {
                desired_.insert(ChunkCoord(centerX + dx, cy, centerZ + dz));
            }
        }
    }

    for (auto it = loaded_.begin(); it != loaded_.end();) {
        if (desired_.find(it->first) == desired_.end()) {
            it = loaded_.erase(it);
        } else {
            ++it;
        }
    }

    if (isInitialLoad) {
        // First-ever load: main.cpp streams chunks before stepping physics
        // this frame (see its call site), and there's no previously-loaded
        // terrain to show while an async load catches up, so this one pass
        // stays synchronous exactly like the old single-threaded path.
        for (const ChunkCoord& coord : desired_) {
            finalizeResult(buildChunkLoadResult(coord));
        }
        return;
    }

    for (const ChunkCoord& coord : desired_) {
        if (loaded_.find(coord) == loaded_.end() && inFlight_.find(coord) == inFlight_.end()) {
            submitJob(coord);
        }
    }
}

Material World::materialAt(glm::ivec3 worldVoxel) const {
    const ChunkCoord coord{
        floorDiv(worldVoxel.x, kChunkSize),
        floorDiv(worldVoxel.y, kChunkSize),
        floorDiv(worldVoxel.z, kChunkSize),
    };
    const auto it = loaded_.find(coord);
    if (it == loaded_.end()) {
        return Material::Air;
    }
    const glm::ivec3 local{
        floorMod(worldVoxel.x, kChunkSize),
        floorMod(worldVoxel.y, kChunkSize),
        floorMod(worldVoxel.z, kChunkSize),
    };
    return it->second.chunk->at(local.x, local.y, local.z);
}

void World::digSphere(glm::vec3 centerWorld, float radiusMeters) {
    const glm::ivec3 centerVoxel(
        static_cast<int>(std::floor(centerWorld.x / kVoxelSize)),
        static_cast<int>(std::floor(centerWorld.y / kVoxelSize)),
        static_cast<int>(std::floor(centerWorld.z / kVoxelSize)));
    const int r = static_cast<int>(std::ceil(radiusMeters / kVoxelSize));

    std::unordered_set<ChunkCoord, ChunkCoordHash> dirty;

    for (int dz = -r; dz <= r; ++dz) {
        for (int dy = -r; dy <= r; ++dy) {
            for (int dx = -r; dx <= r; ++dx) {
                const glm::ivec3 worldVoxel = centerVoxel + glm::ivec3(dx, dy, dz);
                const glm::vec3 voxelCenter = (glm::vec3(worldVoxel) + 0.5f) * kVoxelSize;
                if (glm::length(voxelCenter - centerWorld) > radiusMeters) {
                    continue;
                }

                const ChunkCoord coord{
                    floorDiv(worldVoxel.x, kChunkSize),
                    floorDiv(worldVoxel.y, kChunkSize),
                    floorDiv(worldVoxel.z, kChunkSize),
                };
                const auto it = loaded_.find(coord);
                if (it == loaded_.end()) {
                    continue;
                }

                const glm::ivec3 local{
                    floorMod(worldVoxel.x, kChunkSize),
                    floorMod(worldVoxel.y, kChunkSize),
                    floorMod(worldVoxel.z, kChunkSize),
                };
                Chunk& chunk = *it->second.chunk;
                const Material material = chunk.at(local.x, local.y, local.z);
                if (material == Material::Air || !isHandDiggable(material)) {
                    continue;
                }

                chunk.set(local.x, local.y, local.z, Material::Air);
                dirty.insert(coord);
            }
        }
    }

    for (const ChunkCoord& coord : dirty) {
        LoadedChunk& loadedChunk = loaded_.at(coord);
        loadedChunk.mesh->upload(buildChunkMesh(*loadedChunk.chunk));
    }
}

void World::draw(const Shader& shader) const {
    for (const auto& [coord, loadedChunk] : loaded_) {
        const glm::mat4 model = glm::translate(glm::mat4(1.0f), loadedChunk.chunk->worldOrigin());
        shader.setMat4("uModel", model);
        loadedChunk.mesh->draw();

        for (const VegetationInstance& tree : loadedChunk.trees) {
            shader.setMat4("uModel", glm::translate(glm::mat4(1.0f), tree.origin));
            tree.mesh->draw();
        }
    }
}

void World::drawBushes(const Shader& shader) const {
    for (const auto& [coord, loadedChunk] : loaded_) {
        for (const VegetationInstance& bush : loadedChunk.bushes) {
            shader.setMat4("uModel", glm::translate(glm::mat4(1.0f), bush.origin));
            bush.mesh->draw();
        }
    }
}

} // namespace fgp
