#pragma once

#include <string>

#include "Shader.hpp"

namespace fgp {

// Minimal on-screen text: a fixed 3x5-pixel bitmap font drawn as filled
// quads, reusing the crosshair's plain-white NDC shader. Only supports the
// characters HudText's callers actually need (digits, a handful of letters,
// punctuation) — see HudText.cpp's glyph table. Meant for dev/debug readouts
// (e.g. current FOV), not in-game text.
class HudText {
public:
    HudText();
    ~HudText();

    HudText(const HudText&) = delete;
    HudText& operator=(const HudText&) = delete;
    HudText(HudText&&) = delete;
    HudText& operator=(HudText&&) = delete;

    // Draws text with its top-left at (marginXPixels, marginYPixels) in the
    // framebuffer. Separate X/Y margins let callers stack several HudText
    // instances into vertical lines of a HUD block.
    void draw(const Shader& shader, const std::string& text, int framebufferWidth, int framebufferHeight,
              int marginXPixels = 10, int marginYPixels = 10, int pixelSize = 4);

private:
    void rebuild(const std::string& text, int width, int height, int marginXPixels, int marginYPixels,
                 int pixelSize);

    unsigned int vao_ = 0;
    unsigned int vbo_ = 0;
    int vertexCount_ = 0;

    std::string lastText_;
    int lastWidth_ = -1;
    int lastHeight_ = -1;
    int lastMarginX_ = -1;
    int lastMarginY_ = -1;
    int lastPixelSize_ = -1;
};

} // namespace fgp
