#pragma once

#include <filesystem>

namespace fgp {

// 2D texture loaded from an image file, filtered/wrapped for tiling across
// greedy-meshed voxel quads (see ChunkMesher's UV scheme).
class Texture {
public:
    explicit Texture(const std::filesystem::path& path);
    ~Texture();

    Texture(const Texture&) = delete;
    Texture& operator=(const Texture&) = delete;

    void bind(unsigned int unit = 0) const;

private:
    unsigned int id_ = 0;
};

} // namespace fgp
