#include "TerrainGenerator.hpp"

namespace fgp {

TerrainGenerator::TerrainGenerator(int seed) {
    noise_.SetSeed(seed);
    noise_.SetNoiseType(FastNoiseLite::NoiseType_Perlin);
    noise_.SetFractalType(FastNoiseLite::FractalType_FBm);
    noise_.SetFractalOctaves(4);
    noise_.SetFrequency(0.01f);
}

int TerrainGenerator::borderJitter(int /*worldX*/, int /*worldZ*/) const {
    return 0;
}

int TerrainGenerator::surfaceHeight(int worldX, int worldZ) const {
    const float n = noise_.GetNoise(static_cast<float>(worldX), static_cast<float>(worldZ));
    return baseHeight_ + static_cast<int>(n * static_cast<float>(amplitude_)) + borderJitter(worldX, worldZ);
}

Material TerrainGenerator::materialForDepth(int depthBelowSurface) const {
    if (depthBelowSurface == 0) return Material::Dirt;
    if (depthBelowSurface <= 3) return Material::Gravel;
    if (depthBelowSurface <= 8) return Material::Rock;
    return Material::Granite;
}

void TerrainGenerator::generate(Chunk& chunk) const {
    const glm::ivec3 chunkOrigin = chunk.coord() * kChunkSize;

    for (int x = 0; x < kChunkSize; ++x) {
        for (int z = 0; z < kChunkSize; ++z) {
            const int worldX = chunkOrigin.x + x;
            const int worldZ = chunkOrigin.z + z;
            const int height = surfaceHeight(worldX, worldZ);

            for (int y = 0; y < kChunkSize; ++y) {
                const int worldY = chunkOrigin.y + y;
                if (worldY >= height) {
                    chunk.set(x, y, z, Material::Air);
                } else {
                    chunk.set(x, y, z, materialForDepth(height - worldY - 1));
                }
            }
        }
    }
}

} // namespace fgp
