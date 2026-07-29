#pragma once

#include <filesystem>

namespace fgp {

enum class TextureFilter {
    Tile, // GL_REPEAT + mip-biased linear filtering — terrain/billboard textures (ChunkMesher's UVs exceed [0,1])
    Icon, // GL_CLAMP_TO_EDGE, no mipmap — UI icons drawn near-native size, UVs never leave [0,1]
};

// 2D texture loaded from an image file.
class Texture {
public:
    Texture(const std::filesystem::path& path, TextureFilter filter);
    ~Texture();

    Texture(const Texture&) = delete;
    Texture& operator=(const Texture&) = delete;

    void bind(unsigned int unit = 0) const;

private:
    unsigned int id_ = 0;
};

} // namespace fgp
