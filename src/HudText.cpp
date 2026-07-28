#include "HudText.hpp"

#include <array>
#include <vector>

#include <glad/gl.h>

namespace fgp {

namespace {

using GlyphRows = std::array<std::array<bool, 3>, 5>;

// 3x5 pixel bitmap font, just the characters HudText's callers need.
// Unsupported characters (and space) render blank.
GlyphRows glyphFor(char c) {
    switch (c) {
        case '0': case 'O': return {{ {1,1,1}, {1,0,1}, {1,0,1}, {1,0,1}, {1,1,1} }};
        case '1':           return {{ {0,1,0}, {1,1,0}, {0,1,0}, {0,1,0}, {1,1,1} }};
        case '2':           return {{ {1,1,1}, {0,0,1}, {1,1,1}, {1,0,0}, {1,1,1} }};
        case '3':           return {{ {1,1,1}, {0,0,1}, {1,1,1}, {0,0,1}, {1,1,1} }};
        case '4':           return {{ {1,0,1}, {1,0,1}, {1,1,1}, {0,0,1}, {0,0,1} }};
        case '5':           return {{ {1,1,1}, {1,0,0}, {1,1,1}, {0,0,1}, {1,1,1} }};
        case '6':           return {{ {1,1,1}, {1,0,0}, {1,1,1}, {1,0,1}, {1,1,1} }};
        case '7':           return {{ {1,1,1}, {0,0,1}, {0,0,1}, {0,0,1}, {0,0,1} }};
        case '8':           return {{ {1,1,1}, {1,0,1}, {1,1,1}, {1,0,1}, {1,1,1} }};
        case '9':           return {{ {1,1,1}, {1,0,1}, {1,1,1}, {0,0,1}, {1,1,1} }};
        case 'F':           return {{ {1,1,1}, {1,0,0}, {1,1,1}, {1,0,0}, {1,0,0} }};
        case 'V':           return {{ {1,0,1}, {1,0,1}, {1,0,1}, {1,0,1}, {0,1,0} }};
        case 'P':           return {{ {1,1,1}, {1,0,1}, {1,1,1}, {1,0,0}, {1,0,0} }};
        case 'S':           return {{ {1,1,1}, {1,0,0}, {1,1,1}, {0,0,1}, {1,1,1} }};
        case 'D':           return {{ {1,1,0}, {1,0,1}, {1,0,1}, {1,0,1}, {1,1,0} }};
        case 'I':           return {{ {1,1,1}, {0,1,0}, {0,1,0}, {0,1,0}, {1,1,1} }};
        case 'T':           return {{ {1,1,1}, {0,1,0}, {0,1,0}, {0,1,0}, {0,1,0} }};
        case ':':           return {{ {0,0,0}, {0,1,0}, {0,0,0}, {0,1,0}, {0,0,0} }};
        case '.':           return {{ {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}, {0,1,0} }};
        case '-':           return {{ {0,0,0}, {0,0,0}, {1,1,1}, {0,0,0}, {0,0,0} }};
        default:            return {{ {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0}, {0,0,0} }};
    }
}

constexpr int kGlyphCols = 3;
constexpr int kGlyphRows = 5;
constexpr int kGlyphSpacingCells = 1;

} // namespace

HudText::HudText() {
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &vbo_);

    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 2 * sizeof(float), nullptr);
    glEnableVertexAttribArray(0);
}

HudText::~HudText() {
    glDeleteBuffers(1, &vbo_);
    glDeleteVertexArrays(1, &vao_);
}

void HudText::rebuild(const std::string& text, int width, int height, int marginXPixels, int marginYPixels,
                       int pixelSize) {
    lastText_ = text;
    lastWidth_ = width;
    lastHeight_ = height;
    lastMarginX_ = marginXPixels;
    lastMarginY_ = marginYPixels;
    lastPixelSize_ = pixelSize;

    std::vector<float> vertices;
    vertices.reserve(text.size() * kGlyphCols * kGlyphRows * 12);

    const float w = static_cast<float>(width > 0 ? width : 1);
    const float h = static_cast<float>(height > 0 ? height : 1);
    const int advancePixels = (kGlyphCols + kGlyphSpacingCells) * pixelSize;

    const auto pushPixelRect = [&](int px, int py) {
        // Pixel space has origin top-left, Y down; NDC has origin center, Y up.
        const float x0 = (static_cast<float>(px) / w) * 2.0f - 1.0f;
        const float x1 = (static_cast<float>(px + pixelSize) / w) * 2.0f - 1.0f;
        const float y0 = 1.0f - (static_cast<float>(py) / h) * 2.0f;
        const float y1 = 1.0f - (static_cast<float>(py + pixelSize) / h) * 2.0f;

        // Two triangles, CCW in NDC (doesn't matter — drawn without culling).
        const float quad[12] = {x0, y0, x1, y0, x1, y1, x0, y0, x1, y1, x0, y1};
        vertices.insert(vertices.end(), quad, quad + 12);
    };

    for (std::size_t i = 0; i < text.size(); ++i) {
        const GlyphRows rows = glyphFor(text[i]);
        const int glyphX = marginXPixels + static_cast<int>(i) * advancePixels;
        for (int r = 0; r < kGlyphRows; ++r) {
            for (int c = 0; c < kGlyphCols; ++c) {
                if (!rows[r][c]) {
                    continue;
                }
                pushPixelRect(glyphX + c * pixelSize, marginYPixels + r * pixelSize);
            }
        }
    }

    vertexCount_ = static_cast<int>(vertices.size() / 2);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(vertices.size() * sizeof(float)), vertices.data(),
                 GL_DYNAMIC_DRAW);
}

void HudText::draw(const Shader& shader, const std::string& text, int framebufferWidth, int framebufferHeight,
                    int marginXPixels, int marginYPixels, int pixelSize) {
    if (text != lastText_ || framebufferWidth != lastWidth_ || framebufferHeight != lastHeight_ ||
        marginXPixels != lastMarginX_ || marginYPixels != lastMarginY_ || pixelSize != lastPixelSize_) {
        rebuild(text, framebufferWidth, framebufferHeight, marginXPixels, marginYPixels, pixelSize);
    }

    if (vertexCount_ == 0) {
        return;
    }

    shader.use();
    glBindVertexArray(vao_);
    glDrawArrays(GL_TRIANGLES, 0, vertexCount_);
}

} // namespace fgp
