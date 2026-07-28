#version 330 core

out vec2 vUV;

void main() {
    // Attribute-less full-screen triangle: 3 vertices derived purely from
    // gl_VertexID cover the whole viewport, avoiding a VBO/quad for a pass
    // that's drawn once per frame regardless.
    vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    vUV = pos;
    gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}
