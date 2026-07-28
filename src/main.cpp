#include <array>
#include <cstdio>
#include <cstdlib>
#include <exception>

#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>

#include "Camera.hpp"
#include "Paths.hpp"
#include "Shader.hpp"

namespace {

constexpr int kInitialWidth = 1280;
constexpr int kInitialHeight = 720;

fgp::Camera g_camera;
float g_lastMouseX = kInitialWidth / 2.0f;
float g_lastMouseY = kInitialHeight / 2.0f;
bool g_firstMouse = true;

void framebufferSizeCallback(GLFWwindow*, int width, int height) {
    glViewport(0, 0, width, height);
}

void cursorPosCallback(GLFWwindow*, double xpos, double ypos) {
    if (g_firstMouse) {
        g_lastMouseX = static_cast<float>(xpos);
        g_lastMouseY = static_cast<float>(ypos);
        g_firstMouse = false;
    }

    const float xOffset = static_cast<float>(xpos) - g_lastMouseX;
    // Screen-space Y grows downward; invert so moving the mouse up looks up.
    const float yOffset = g_lastMouseY - static_cast<float>(ypos);
    g_lastMouseX = static_cast<float>(xpos);
    g_lastMouseY = static_cast<float>(ypos);

    g_camera.look(xOffset, yOffset);
}

void processInput(GLFWwindow* window, float deltaTime) {
    if (glfwGetKey(window, GLFW_KEY_ESCAPE) == GLFW_PRESS) {
        glfwSetWindowShouldClose(window, true);
    }
    if (glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Forward, deltaTime);
    }
    if (glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Backward, deltaTime);
    }
    if (glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Left, deltaTime);
    }
    if (glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Right, deltaTime);
    }
    if (glfwGetKey(window, GLFW_KEY_SPACE) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Up, deltaTime);
    }
    if (glfwGetKey(window, GLFW_KEY_LEFT_SHIFT) == GLFW_PRESS) {
        g_camera.move(fgp::CameraMove::Down, deltaTime);
    }
}

// A unit cube, per-vertex colored per face, standing in for voxel terrain
// until chunk meshing exists (Phase 1). Proves the position+color vertex
// layout the terrain mesher will also use.
// clang-format off
constexpr std::array<float, 6 * 6 * 6> kCubeVertices = {
    // positions          // colors (per face)
    -0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.25f,
     0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.25f,
     0.5f,  0.5f, -0.5f,  0.85f, 0.25f, 0.25f,
     0.5f,  0.5f, -0.5f,  0.85f, 0.25f, 0.25f,
    -0.5f,  0.5f, -0.5f,  0.85f, 0.25f, 0.25f,
    -0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.25f,

    -0.5f, -0.5f,  0.5f,  0.25f, 0.85f, 0.25f,
     0.5f, -0.5f,  0.5f,  0.25f, 0.85f, 0.25f,
     0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.25f,
     0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.25f,
    -0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.25f,
    -0.5f, -0.5f,  0.5f,  0.25f, 0.85f, 0.25f,

    -0.5f,  0.5f,  0.5f,  0.25f, 0.25f, 0.85f,
    -0.5f,  0.5f, -0.5f,  0.25f, 0.25f, 0.85f,
    -0.5f, -0.5f, -0.5f,  0.25f, 0.25f, 0.85f,
    -0.5f, -0.5f, -0.5f,  0.25f, 0.25f, 0.85f,
    -0.5f, -0.5f,  0.5f,  0.25f, 0.25f, 0.85f,
    -0.5f,  0.5f,  0.5f,  0.25f, 0.25f, 0.85f,

     0.5f,  0.5f,  0.5f,  0.85f, 0.85f, 0.25f,
     0.5f,  0.5f, -0.5f,  0.85f, 0.85f, 0.25f,
     0.5f, -0.5f, -0.5f,  0.85f, 0.85f, 0.25f,
     0.5f, -0.5f, -0.5f,  0.85f, 0.85f, 0.25f,
     0.5f, -0.5f,  0.5f,  0.85f, 0.85f, 0.25f,
     0.5f,  0.5f,  0.5f,  0.85f, 0.85f, 0.25f,

    -0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.85f,
     0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.85f,
     0.5f, -0.5f,  0.5f,  0.85f, 0.25f, 0.85f,
     0.5f, -0.5f,  0.5f,  0.85f, 0.25f, 0.85f,
    -0.5f, -0.5f,  0.5f,  0.85f, 0.25f, 0.85f,
    -0.5f, -0.5f, -0.5f,  0.85f, 0.25f, 0.85f,

    -0.5f,  0.5f, -0.5f,  0.25f, 0.85f, 0.85f,
     0.5f,  0.5f, -0.5f,  0.25f, 0.85f, 0.85f,
     0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.85f,
     0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.85f,
    -0.5f,  0.5f,  0.5f,  0.25f, 0.85f, 0.85f,
    -0.5f,  0.5f, -0.5f,  0.25f, 0.85f, 0.85f,
};
// clang-format on

int run() {
    if (!glfwInit()) {
        std::fprintf(stderr, "failed to initialize GLFW\n");
        return EXIT_FAILURE;
    }

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 3);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#endif

    GLFWwindow* window = glfwCreateWindow(kInitialWidth, kInitialHeight, "fatguyphysics", nullptr, nullptr);
    if (!window) {
        std::fprintf(stderr, "failed to create window\n");
        glfwTerminate();
        return EXIT_FAILURE;
    }

    glfwMakeContextCurrent(window);
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
    glfwSetFramebufferSizeCallback(window, framebufferSizeCallback);
    glfwSetCursorPosCallback(window, cursorPosCallback);

    if (!gladLoadGL(reinterpret_cast<GLADloadfunc>(glfwGetProcAddress))) {
        std::fprintf(stderr, "failed to load OpenGL via glad\n");
        glfwTerminate();
        return EXIT_FAILURE;
    }

    glEnable(GL_DEPTH_TEST);

    unsigned int vao = 0;
    unsigned int vbo = 0;
    glGenVertexArrays(1, &vao);
    glGenBuffers(1, &vbo);

    glBindVertexArray(vao);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof(kCubeVertices), kCubeVertices.data(), GL_STATIC_DRAW);

    const GLsizei stride = 6 * sizeof(float);
    glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(0));
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(1, 3, GL_FLOAT, GL_FALSE, stride, reinterpret_cast<void*>(3 * sizeof(float)));
    glEnableVertexAttribArray(1);

    const std::filesystem::path shaderDir = fgp::executableDir() / "assets" / "shaders";
    fgp::Shader shader(shaderDir / "basic.vert", shaderDir / "basic.frag");

    float lastFrameTime = static_cast<float>(glfwGetTime());

    while (!glfwWindowShouldClose(window)) {
        const float currentFrameTime = static_cast<float>(glfwGetTime());
        const float deltaTime = currentFrameTime - lastFrameTime;
        lastFrameTime = currentFrameTime;

        processInput(window, deltaTime);

        glClearColor(0.53f, 0.72f, 0.86f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        int width = 0;
        int height = 0;
        glfwGetFramebufferSize(window, &width, &height);
        const float aspect = height > 0 ? static_cast<float>(width) / static_cast<float>(height) : 1.0f;

        const glm::mat4 model(1.0f);
        const glm::mat4 view = g_camera.viewMatrix();
        const glm::mat4 projection = glm::perspective(glm::radians(g_camera.fovDegrees), aspect, 0.1f, 100.0f);

        shader.use();
        shader.setMat4("uModel", model);
        shader.setMat4("uView", view);
        shader.setMat4("uProjection", projection);

        glBindVertexArray(vao);
        glDrawArrays(GL_TRIANGLES, 0, static_cast<GLsizei>(kCubeVertices.size() / 6));

        glfwSwapBuffers(window);
        glfwPollEvents();
    }

    glDeleteVertexArrays(1, &vao);
    glDeleteBuffers(1, &vbo);

    glfwTerminate();
    return EXIT_SUCCESS;
}

} // namespace

int main() {
    try {
        return run();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "fatal error: %s\n", e.what());
        return EXIT_FAILURE;
    }
}
