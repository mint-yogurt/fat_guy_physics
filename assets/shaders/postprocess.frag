#version 330 core

in vec2 vUV;
out vec4 FragColor;

uniform sampler2D uScene;
uniform float uAberration;
uniform float uBleedStrength;
uniform float uBleedLod;

void main() {
    // Radial chromatic aberration: red/blue sample outward/inward from
    // screen center by an offset that grows with distance from it, so the
    // effect stays subtle in the middle of the view and fringes at the
    // edges like a real lens. Three texture fetches total.
    vec2 offset = (vUV - 0.5) * uAberration;
    float r = texture(uScene, vUV + offset).r;
    float g = texture(uScene, vUV).g;
    float b = texture(uScene, vUV - offset).b;
    vec3 sharp = vec3(r, g, b);

    // A higher mip level of the same texture is a free box blur (the mip
    // chain is already generated via glGenerateMipmap), so this reuses it
    // as the soft "bleed" source instead of a dedicated blur pass — one
    // extra texture fetch for the whole effect. Blending toward it (rather
    // than adding it) keeps overall brightness bounded instead of blowing
    // out bright scenery like the sky.
    vec3 bleed = textureLod(uScene, vUV, uBleedLod).rgb;
    vec3 color = mix(sharp, bleed, uBleedStrength);
    FragColor = vec4(color, 1.0);
}
