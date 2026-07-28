#include "PostProcess.hpp"

#include <glad/gl.h>

namespace fgp {

namespace {

// Mip level the "color bleed" pass samples for its blur source. Not
// user-dialable (unlike the two strengths) — it just needs to be blurry
// enough that bleeding is visible; the composite shader's textureLod call
// clamps this to whatever mip levels actually exist at the current
// resolution, so it stays safe even on a tiny framebuffer.
constexpr float kBleedLod = 4.0f;

} // namespace

PostProcess::PostProcess() {
    glGenFramebuffers(1, &fbo_);
    glGenTextures(1, &colorTexture_);
    glGenRenderbuffers(1, &depthRenderbuffer_);
    // The fullscreen triangle is generated entirely from gl_VertexID in
    // postprocess.vert — no vertex data needed, just a VAO to satisfy core
    // profile's "a VAO must be bound to draw" rule.
    glGenVertexArrays(1, &vao_);
}

PostProcess::~PostProcess() {
    glDeleteVertexArrays(1, &vao_);
    glDeleteRenderbuffers(1, &depthRenderbuffer_);
    glDeleteTextures(1, &colorTexture_);
    glDeleteFramebuffers(1, &fbo_);
}

void PostProcess::resize(int width, int height) {
    width_ = width;
    height_ = height;

    glBindTexture(GL_TEXTURE_2D, colorTexture_);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGB8, width, height, 0, GL_RGB, GL_UNSIGNED_BYTE, nullptr);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR_MIPMAP_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
    // The bleed pass only ever samples up to kBleedLod, so cap mip
    // generation there instead of building the full chain down to 1x1 every
    // frame — real bandwidth savings at native resolution for a one-line
    // change.
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAX_LEVEL, static_cast<int>(kBleedLod));

    glBindRenderbuffer(GL_RENDERBUFFER, depthRenderbuffer_);
    glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH_COMPONENT24, width, height);

    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, colorTexture_, 0);
    glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, GL_RENDERBUFFER, depthRenderbuffer_);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

void PostProcess::begin(int framebufferWidth, int framebufferHeight) {
    // Minimized windows report a zero-sized framebuffer; skip (re)allocating
    // a texture/renderbuffer with zero extent until it's visible again.
    if (framebufferWidth <= 0 || framebufferHeight <= 0) {
        captured_ = false;
        return;
    }
    if (framebufferWidth != width_ || framebufferHeight != height_) {
        resize(framebufferWidth, framebufferHeight);
    }
    captured_ = true;
    glBindFramebuffer(GL_FRAMEBUFFER, fbo_);
}

void PostProcess::end(const Shader& compositeShader, float aberrationStrength, float bleedStrength) {
    if (!captured_) {
        return;
    }

    // Unbind the FBO before generating mipmaps for the texture that was
    // just its color attachment — some drivers warn/misbehave when a
    // texture is mip-generated while still bound as the active draw target.
    glBindFramebuffer(GL_FRAMEBUFFER, 0);

    // Hardware mip generation doubles as the "color bleed" blur source the
    // composite shader samples below — far cheaper than a dedicated blur
    // pass for a similar soft, bleeding look. GL_TEXTURE_MAX_LEVEL (set in
    // resize()) caps this at kBleedLod instead of building the full chain.
    glBindTexture(GL_TEXTURE_2D, colorTexture_);
    glGenerateMipmap(GL_TEXTURE_2D);

    glDisable(GL_DEPTH_TEST);
    glDisable(GL_CULL_FACE);

    compositeShader.use();
    compositeShader.setInt("uScene", 0);
    compositeShader.setFloat("uAberration", aberrationStrength);
    compositeShader.setFloat("uBleedStrength", bleedStrength);
    compositeShader.setFloat("uBleedLod", kBleedLod);
    glActiveTexture(GL_TEXTURE0);
    glBindTexture(GL_TEXTURE_2D, colorTexture_);

    glBindVertexArray(vao_);
    glDrawArrays(GL_TRIANGLES, 0, 3);

    glEnable(GL_CULL_FACE);
    glEnable(GL_DEPTH_TEST);
}

} // namespace fgp
