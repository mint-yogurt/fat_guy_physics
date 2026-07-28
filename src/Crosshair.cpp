#include "Crosshair.hpp"

#include <array>

#include <glad/gl.h>

namespace fgp {

namespace {
constexpr float kArmLengthPixels = 8.0f;
}

Crosshair::Crosshair() {
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &vbo_);

    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);

    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 2 * sizeof(float), nullptr);
    glEnableVertexAttribArray(0);
}

Crosshair::~Crosshair() {
    glDeleteBuffers(1, &vbo_);
    glDeleteVertexArrays(1, &vao_);
}

void Crosshair::rebuild(int width, int height) {
    lastWidth_ = width;
    lastHeight_ = height;

    const float hx = width > 0 ? 2.0f * kArmLengthPixels / static_cast<float>(width) : 0.0f;
    const float hy = height > 0 ? 2.0f * kArmLengthPixels / static_cast<float>(height) : 0.0f;

    const std::array<float, 8> vertices = {
        -hx, 0.0f, hx, 0.0f, // horizontal arm
        0.0f, -hy, 0.0f, hy, // vertical arm
    };

    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glBufferData(GL_ARRAY_BUFFER, static_cast<GLsizeiptr>(vertices.size() * sizeof(float)), vertices.data(),
                 GL_DYNAMIC_DRAW);
}

void Crosshair::draw(const Shader& shader, int framebufferWidth, int framebufferHeight) {
    if (framebufferWidth != lastWidth_ || framebufferHeight != lastHeight_) {
        rebuild(framebufferWidth, framebufferHeight);
    }

    shader.use();
    glBindVertexArray(vao_);
    glDrawArrays(GL_LINES, 0, 4);
}

} // namespace fgp
