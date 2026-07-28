#include <cstdio>
#include <cstdlib>
#include <exception>

#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>

#include "Camera.hpp"
#include "Paths.hpp"
#include "Shader.hpp"
#include "voxel/World.hpp"

namespace {

constexpr int kInitialWidth = 1280;
constexpr int kInitialHeight = 720;

// Above the generator's max surface height (baseHeight_ + amplitude_ ~= 8.8m)
// so the world is visible on the horizon without the camera starting underground.
fgp::Camera g_camera(glm::vec3(0.0f, 12.0f, 20.0f));
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
    glEnable(GL_CULL_FACE);

    const std::filesystem::path shaderDir = fgp::executableDir() / "assets" / "shaders";
    fgp::Shader shader(shaderDir / "basic.vert", shaderDir / "basic.frag");

    fgp::World world(/*seed=*/1337);

    float lastFrameTime = static_cast<float>(glfwGetTime());

    while (!glfwWindowShouldClose(window)) {
        const float currentFrameTime = static_cast<float>(glfwGetTime());
        const float deltaTime = currentFrameTime - lastFrameTime;
        lastFrameTime = currentFrameTime;

        processInput(window, deltaTime);
        world.update(g_camera.position());

        glClearColor(0.53f, 0.72f, 0.86f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

        int width = 0;
        int height = 0;
        glfwGetFramebufferSize(window, &width, &height);
        const float aspect = height > 0 ? static_cast<float>(width) / static_cast<float>(height) : 1.0f;

        const glm::mat4 view = g_camera.viewMatrix();
        const glm::mat4 projection = glm::perspective(glm::radians(g_camera.fovDegrees), aspect, 0.1f, 100.0f);

        shader.use();
        shader.setMat4("uView", view);
        shader.setMat4("uProjection", projection);

        world.draw(shader);

        glfwSwapBuffers(window);
        glfwPollEvents();
    }

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
