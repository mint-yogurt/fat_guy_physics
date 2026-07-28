#include "World.hpp"

#include <cmath>
#include <unordered_set>

#include <glm/gtc/matrix_transform.hpp>

#include "ChunkMesher.hpp"

namespace fgp {

World::World(int seed, int loadRadiusChunks) : generator_(seed), loadRadiusChunks_(loadRadiusChunks) {}

void World::loadChunk(ChunkCoord coord) {
    auto chunk = std::make_unique<Chunk>(coord);
    generator_.generate(*chunk);

    auto mesh = std::make_unique<ChunkMesh>();
    mesh->upload(buildChunkMesh(*chunk));

    loaded_[coord] = LoadedChunk{std::move(chunk), std::move(mesh)};
}

void World::update(glm::vec3 cameraWorldPos) {
    const float chunkWorldSize = static_cast<float>(kChunkSize) * kVoxelSize;
    const int centerX = static_cast<int>(std::floor(cameraWorldPos.x / chunkWorldSize));
    const int centerZ = static_cast<int>(std::floor(cameraWorldPos.z / chunkWorldSize));

    if (hasCenter_ && centerX == centerX_ && centerZ == centerZ_) {
        return;
    }
    hasCenter_ = true;
    centerX_ = centerX;
    centerZ_ = centerZ;

    std::unordered_set<ChunkCoord, ChunkCoordHash> desired;
    const int radiusSq = loadRadiusChunks_ * loadRadiusChunks_;
    for (int dx = -loadRadiusChunks_; dx <= loadRadiusChunks_; ++dx) {
        for (int dz = -loadRadiusChunks_; dz <= loadRadiusChunks_; ++dz) {
            if (dx * dx + dz * dz > radiusSq) {
                continue;
            }
            for (int cy = kVerticalChunkMin; cy <= kVerticalChunkMax; ++cy) {
                desired.insert(ChunkCoord(centerX + dx, cy, centerZ + dz));
            }
        }
    }

    for (auto it = loaded_.begin(); it != loaded_.end();) {
        if (desired.find(it->first) == desired.end()) {
            it = loaded_.erase(it);
        } else {
            ++it;
        }
    }

    for (const ChunkCoord& coord : desired) {
        if (loaded_.find(coord) == loaded_.end()) {
            loadChunk(coord);
        }
    }
}

void World::draw(const Shader& shader) const {
    for (const auto& [coord, loadedChunk] : loaded_) {
        const glm::mat4 model = glm::translate(glm::mat4(1.0f), loadedChunk.chunk->worldOrigin());
        shader.setMat4("uModel", model);
        loadedChunk.mesh->draw();
    }
}

} // namespace fgp
