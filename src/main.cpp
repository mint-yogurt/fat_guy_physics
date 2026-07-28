#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <exception>

#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>

#include "Camera.hpp"
#include "Crosshair.hpp"
#include "Paths.hpp"
#include "Shader.hpp"
#include "Texture.hpp"
#include "voxel/VoxelRaycast.hpp"
#include "voxel/World.hpp"

namespace {

constexpr int kInitialWidth = 1280;
constexpr int kInitialHeight = 720;

constexpr float kDigTickSeconds = 0.15f;
constexpr float kDigReachMeters = 5.0f;
constexpr float kDigRadiusMeters = 0.35f;

// Bare-handed digging (no shovel/tool exists yet) ramps up to the full
// scoop radius over a few ticks of holding still on the same spot, rather
// than instantly carving the full hole — a shovel would presumably reach
// full radius on tick one; hands shouldn't.
constexpr int kDigTicksToFullRadius = 3;
constexpr float kDigStreakPositionEpsilon = 0.01f; // meters
constexpr float kDigStreakDirectionEpsilon = 0.999f; // cos(angle); ~2.6 degrees

// Above the generator's max surface height (baseHeight_ + amplitude_ ~= 8.8m)
// so the world is visible on the horizon without the camera starting underground.
fgp::Camera g_camera(glm::vec3(0.0f, 12.0f, 20.0f));
float g_lastMouseX = kInitialWidth / 2.0f;
float g_lastMouseY = kInitialHeight / 2.0f;
bool g_firstMouse = true;
float g_digCooldown = 0.0f;
int g_digStreakTicks = 0;
glm::vec3 g_digStreakOrigin(0.0f);
glm::vec3 g_digStreakDirection(0.0f, 0.0f, -1.0f);

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

void processInput(GLFWwindow* window, float deltaTime, fgp::World& world) {
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

    g_digCooldown -= deltaTime;
    if (glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS) {
        if (g_digCooldown <= 0.0f) {
            const glm::vec3 origin = g_camera.position();
            const glm::vec3 direction = g_camera.front();

            const bool sameSpot = g_digStreakTicks > 0 &&
                                   glm::distance(origin, g_digStreakOrigin) <= kDigStreakPositionEpsilon &&
                                   glm::dot(direction, g_digStreakDirection) >= kDigStreakDirectionEpsilon;
            g_digStreakTicks = sameSpot ? std::min(g_digStreakTicks + 1, kDigTicksToFullRadius) : 1;
            g_digStreakOrigin = origin;
            g_digStreakDirection = direction;

            const auto hit = fgp::raycastVoxel(world, origin, direction, kDigReachMeters);
            if (hit) {
                const glm::vec3 hitCenter = (glm::vec3(*hit) + 0.5f) * fgp::kVoxelSize;
                const float radius =
                    kDigRadiusMeters * static_cast<float>(g_digStreakTicks) / static_cast<float>(kDigTicksToFullRadius);
                world.digSphere(hitCenter, radius);
            }
            g_digCooldown = kDigTickSeconds;
        }
    } else {
        // A quick tap must always produce exactly one (small, first-tick)
        // scoop; resetting to 0 (rather than letting the cooldown run
        // negative) also stops a release-then-repress from firing a
        // queued burst of digs. Releasing also resets the ramp-up streak.
        g_digCooldown = 0.0f;
        g_digStreakTicks = 0;
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

    // Scoped so every GL-owning object below is destroyed (freeing VAOs,
    // VBOs, textures, shader programs) before glfwTerminate() destroys the
    // context those destructors need to call into.
    {
        const std::filesystem::path shaderDir = fgp::executableDir() / "assets" / "shaders";
        fgp::Shader shader(shaderDir / "basic.vert", shaderDir / "basic.frag");
        fgp::Shader crosshairShader(shaderDir / "crosshair.vert", shaderDir / "crosshair.frag");
        fgp::Crosshair crosshair;

        fgp::Texture cobbleTexture(fgp::executableDir() / "assets" / "textures" / "cobble.png");
        shader.use();
        shader.setInt("uTexture", 0);

        fgp::World world(/*seed=*/1337);

        float lastFrameTime = static_cast<float>(glfwGetTime());

        while (!glfwWindowShouldClose(window)) {
            const float currentFrameTime = static_cast<float>(glfwGetTime());
            const float deltaTime = currentFrameTime - lastFrameTime;
            lastFrameTime = currentFrameTime;

            processInput(window, deltaTime, world);
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
            cobbleTexture.bind(0);

            world.draw(shader);

            glDisable(GL_DEPTH_TEST);
            crosshair.draw(crosshairShader, width, height);
            glEnable(GL_DEPTH_TEST);

            glfwSwapBuffers(window);
            glfwPollEvents();
        }
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
