#include "World.hpp"

#include <cmath>
#include <unordered_set>

#include <glm/gtc/matrix_transform.hpp>

#include "ChunkMesher.hpp"

namespace fgp {

World::World(int seed, int loadRadiusChunks) : generator_(seed), seed_(seed), loadRadiusChunks_(loadRadiusChunks) {}

void World::loadChunk(ChunkCoord coord) {
    auto chunk = std::make_unique<Chunk>(coord);
    generator_.generate(*chunk);

    auto mesh = std::make_unique<ChunkMesh>();
    mesh->upload(buildChunkMesh(*chunk));

    VegetationBatch vegetation = generateVegetation(generator_, coord, seed_);

    loaded_[coord] = LoadedChunk{std::move(chunk), std::move(mesh), std::move(vegetation.trees), std::move(vegetation.bushes)};
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
