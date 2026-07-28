#version 330 core

in vec3 vColor;
in vec2 vUV;
out vec4 FragColor;

uniform sampler2D uTexture;

// Forces sampling from a blurrier mip level than the fragment's screen-space
// footprint would normally pick, for the soft/low-res filtered look
// DESIGN.md's visual direction calls for.
const float kTextureLodBias = 2.0;

void main() {
    vec3 detail = texture(uTexture, vUV, kTextureLodBias).rgb;
    FragColor = vec4(detail * vColor, 1.0);
}
