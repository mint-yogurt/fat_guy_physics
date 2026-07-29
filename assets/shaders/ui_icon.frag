#version 330 core

in vec2 vUV;
out vec4 FragColor;

uniform sampler2D uTexture;
// Multiplied over the sampled color — (1,1,1,1) for a plain icon, a
// brighter/tinted value for the selected hotbar slot's highlight, a darker
// one to dim unselected slots, etc.
uniform vec4 uTint;

void main() {
    // Real alpha blending (see the draw call's glBlendFunc), not the
    // shared opaque pass's cutout discard — icon edges should antialias
    // smoothly instead of hard-cutting at alpha 0.5.
    FragColor = texture(uTexture, vUV) * uTint;
}
