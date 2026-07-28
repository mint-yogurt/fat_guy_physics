#pragma once

#include "Shader.hpp"

namespace fgp {

// Cheap full-screen post-process: the 3D scene renders into an offscreen
// target instead of the default framebuffer, then gets composited back with
// a couple of stylized, dialable effects (chromatic aberration + a
// mip-blur "color bleed"/bloom). Both effects are just a few extra texture
// samples on a single attribute-less full-screen triangle, and the blur
// reuses hardware mipmap generation instead of a dedicated blur pass, so
// the added per-frame cost is one FBO render target and a handful of
// texture fetches.
class PostProcess {
public:
    PostProcess();
    ~PostProcess();

    PostProcess(const PostProcess&) = delete;
    PostProcess& operator=(const PostProcess&) = delete;
    PostProcess(PostProcess&&) = delete;
    PostProcess& operator=(PostProcess&&) = delete;

    // Redirects rendering into the offscreen target, (re)allocating it first
    // if the framebuffer size changed. Callers should clear and render the
    // 3D scene (with depth testing) after calling this.
    void begin(int framebufferWidth, int framebufferHeight);

    // Restores the default framebuffer and draws the composited result
    // (chromatic aberration + color bleed applied) as a full-screen
    // triangle. Callers should draw undistorted screen-space UI (HUD,
    // crosshair) after this returns.
    void end(const Shader& compositeShader, float aberrationStrength, float bleedStrength);

private:
    void resize(int width, int height);

    unsigned int fbo_ = 0;
    unsigned int colorTexture_ = 0;
    unsigned int depthRenderbuffer_ = 0;
    unsigned int vao_ = 0; // empty VAO; the fullscreen triangle needs no vertex data
    int width_ = -1;
    int height_ = -1;
    // False while the framebuffer is zero-sized (window minimized); begin()
    // skips binding the FBO in that case, so end() must not composite a
    // stale texture through — width_/height_ alone can't tell the two apart
    // since they hold onto the last valid size.
    bool captured_ = false;
};

} // namespace fgp
