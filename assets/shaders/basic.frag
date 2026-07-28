#version 330 core

in vec3 vColor;
in vec2 vUV;
in vec3 vNormal;
out vec4 FragColor;

uniform sampler2D uTexture;

// Forces sampling from a blurrier mip level than the fragment's screen-space
// footprint would normally pick, for the soft/low-res filtered look
// DESIGN.md's visual direction calls for.
const float kTextureLodBias = 2.0;

// One fixed directional "sun" plus a flat ambient floor — no shadow maps,
// just enough real-time shading (on top of ChunkMesher's baked per-face
// tint) that terrain reads as 3D shapes instead of a flat color wash once
// you're a few meters out and the texture detail stops helping.
const vec3 kSunDirection = vec3(0.4, 1.0, 0.3);
const vec3 kAmbient = vec3(0.55);
const vec3 kSunColor = vec3(0.65);

void main() {
    vec4 detail = texture(uTexture, vUV, kTextureLodBias);
    // Alpha-cutout rather than blending: lets billboard sprites (bush.png)
    // share this shader/opaque-geometry depth pass with terrain and trees
    // instead of needing a sorted transparent pass. Opaque textures (cobble,
    // white) are alpha=1 everywhere, so this is a no-op for them.
    if (detail.a < 0.5) {
        discard;
    }
    float ndotl = max(dot(normalize(vNormal), normalize(kSunDirection)), 0.0);
    vec3 lighting = kAmbient + kSunColor * ndotl;
    FragColor = vec4(detail.rgb * vColor * lighting, 1.0);
}
