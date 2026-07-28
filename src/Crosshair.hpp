#pragma once

#include "Shader.hpp"

namespace fgp {

// Small screen-space cross drawn at the window center, so the player can
// see where the (hidden, captured) cursor is aimed for the dig raycast.
class Crosshair {
public:
    Crosshair();
    ~Crosshair();

    Crosshair(const Crosshair&) = delete;
    Crosshair& operator=(const Crosshair&) = delete;
    Crosshair(Crosshair&&) = delete;
    Crosshair& operator=(Crosshair&&) = delete;

    void draw(const Shader& shader, int framebufferWidth, int framebufferHeight);

private:
    void rebuild(int width, int height);

    unsigned int vao_ = 0;
    unsigned int vbo_ = 0;
    int lastWidth_ = -1;
    int lastHeight_ = -1;
};

} // namespace fgp
