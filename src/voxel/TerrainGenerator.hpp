#pragma once

#include <cstdint>

#include <FastNoiseLite.h>

#include "Chunk.hpp"

namespace fgp {

// Heightmap-based generator: 2D fractal noise picks a surface height per
// (x,z) column, everything below is solid (banded by depth), everything
// above is air. No caves/overhangs at generation time (see Phase 1 scope);
// excavation carves those in later.
class TerrainGenerator {
public:
    explicit TerrainGenerator(int seed);

    // Surface height in voxel units (world Y = height * kVoxelSize) at the
    // given voxel-grid column.
    int surfaceHeight(int worldX, int worldZ) const;

    void generate(Chunk& chunk) const;

private:
    // Per-column height jitter to break up the regular look of chunk edges
    // where the same noise field is sampled on both sides of a border.
    // Not implemented yet — deliberately returns 0 for now; wire this up
    // when the seam/grid look at chunk borders actually needs fixing.
    int borderJitter(int worldX, int worldZ) const;

    Material materialForDepth(int depthBelowSurface) const;

    FastNoiseLite noise_;
    int baseHeight_ = 64;
    int amplitude_ = 24;
};

} // namespace fgp
