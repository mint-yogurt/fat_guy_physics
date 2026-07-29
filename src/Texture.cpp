#include "Texture.hpp"

#include <stdexcept>

#include <glad/gl.h>
#include <stb_image.h>

namespace fgp {

Texture::Texture(const std::filesystem::path& path, TextureFilter filter) {
    stbi_set_flip_vertically_on_load(true);

    int width = 0;
    int height = 0;
    int channelsInFile = 0;
    unsigned char* pixels = stbi_load(path.string().c_str(), &width, &height, &channelsInFile, 4);
    if (!pixels) {
        throw std::runtime_error("failed to load texture: " + path.string());
    }

    glGenTextures(1, &id_);
    glBindTexture(GL_TEXTURE_2D, id_);

    if (filter == TextureFilter::Tile) {
        // GL_REPEAT so greedy-meshed quads (which tile the texture once per
        // voxel via UVs that exceed [0,1]) wrap instead of clamping/stretching.
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_REPEAT);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_REPEAT);
        // Linear + mipmapped filtering on a small source texture is the
        // deliberately soft, low-res-console look DESIGN.md calls for.
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
        glGenerateMipmap(GL_TEXTURE_2D);
    } else {
        // Icons: UVs never leave a single quad's [0,1] so wrap mode is
        // moot in practice, but CLAMP_TO_EDGE avoids any edge bleed from
        // the opposite side the way REPEAT's implicit wrap could. No
        // mipmap/LOD bias — icons draw near their native size, and the
        // retro mip-blur that suits terrain would just soften them for
        // no reason.
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
        glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, pixels);
    }

    stbi_image_free(pixels);
}

Texture::~Texture() {
    glDeleteTextures(1, &id_);
}

void Texture::bind(unsigned int unit) const {
    glActiveTexture(GL_TEXTURE0 + unit);
    glBindTexture(GL_TEXTURE_2D, id_);
}

} // namespace fgp
