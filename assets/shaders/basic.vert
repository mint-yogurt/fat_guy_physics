#version 330 core

layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aColor;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec3 aNormal;

uniform mat4 uModel;
uniform mat4 uView;
uniform mat4 uProjection;

out vec3 vColor;
out vec2 vUV;
out vec3 vNormal;

void main() {
    gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
    vColor = aColor;
    vUV = aUV;
    // uModel is always translate + uniform rotate/scale (chunks: translate
    // only; player ball: rotate + uniform scale) — no non-uniform scale, so
    // the model matrix itself carries normals correctly without needing the
    // inverse-transpose normal matrix.
    vNormal = mat3(uModel) * aNormal;
}
