#version 330 core

// Unit quad in [0,1]x[0,1], shared by every icon draw — position/size vary
// per draw via uniforms (icons each need their own texture bind, so unlike
// Crosshair/HudText this can't be one big precomputed vertex buffer; a
// shared unit quad transformed per draw matches how 3D meshes in this
// project already reuse one buffer via a per-draw model matrix).
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec2 aUV;

out vec2 vUV;

uniform vec2 uSlotPixelPos;  // top-left corner, framebuffer pixels
uniform vec2 uSlotPixelSize;
uniform vec2 uFramebufferSize;

void main() {
    vec2 pixelPos = uSlotPixelPos + aPosition * uSlotPixelSize;
    vec2 ndc = (pixelPos / uFramebufferSize) * 2.0 - 1.0;
    ndc.y = -ndc.y; // pixel Y grows downward, NDC Y grows upward
    gl_Position = vec4(ndc, 0.0, 1.0);
    vUV = aUV;
}
