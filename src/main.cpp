#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <exception>
#include <string>

#include <glad/gl.h>
#include <GLFW/glfw3.h>
#include <glm/gtc/matrix_transform.hpp>
#include <glm/gtc/quaternion.hpp>

#include "Camera.hpp"
#include "Crosshair.hpp"
#include "HudText.hpp"
#include "Paths.hpp"
#include "Player.hpp"
#include "PlayerMesh.hpp"
#include "Shader.hpp"
#include "Texture.hpp"
#include "voxel/ChunkMesh.hpp"
#include "voxel/VoxelRaycast.hpp"
#include "voxel/World.hpp"

namespace {

constexpr int kInitialWidth = 640;
constexpr int kInitialHeight = 360;

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

constexpr float kFovAdjustDegreesPerSecond = 40.0f;
constexpr float kMinFovDegrees = 30.0f;
constexpr float kMaxFovDegrees = 120.0f;

// How far out the crosshair-distance HUD readout looks for something to
// report on; matches the projection's far clip plane so it can report
// anything actually visible.
constexpr float kHudRaycastReachMeters = 100.0f;

// Exponential smoothing factor for the FPS readout — raw 1/frameTime is too
// jittery frame-to-frame to read.
constexpr float kFpsSmoothing = 0.1f;

constexpr int kHudMarginX = 10;
constexpr int kHudLineHeight = 28;

// Fixed-timestep physics: chunk generation is synchronous (see World's
// streaming comment) and can spike a frame by hundreds of ms. At 0.1m
// voxels, integrating a big raw deltaTime in one step would tunnel the
// player through terrain. Substepping at a small fixed dt bounds how far
// any single step can move regardless of frame time.
constexpr float kFixedTimestep = 1.0f / 120.0f;
constexpr float kMaxFrameTime = 0.1f;
constexpr int kMaxSubsteps = 8;

const glm::vec3 kPlayerBodyColor(0.85f, 0.65f, 0.45f);

// Above the generator's max surface height (baseHeight_ + amplitude_ ~= 8.8m)
// so the world is visible on the horizon without the player starting
// underground.
fgp::Player g_player(glm::vec3(0.0f, 12.0f, 20.0f));
fgp::Camera g_camera;
float g_lastMouseX = kInitialWidth / 2.0f;
float g_lastMouseY = kInitialHeight / 2.0f;
bool g_firstMouse = true;
float g_digCooldown = 0.0f;
int g_digStreakTicks = 0;
glm::vec3 g_digStreakOrigin(0.0f);
glm::vec3 g_digStreakDirection(0.0f, 0.0f, -1.0f);
bool g_ragballKeyWasDown = false;
bool g_perspectiveKeyWasDown = false;
bool g_cursorFreeKeyWasDown = false;
bool g_captureClickWasDown = false;
bool g_escapeKeyWasDown = false;
// Starts free (visible, unlocked) so the window is immediately resizable/
// movable on launch; a click into the viewport captures it for mouselook.
bool g_cursorFree = true;
float g_fpsSmoothed = 0.0f;

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

    // While the cursor is free (window-management mode), ordinary mouse
    // movement over the client area shouldn't also spin the camera.
    if (!g_cursorFree) {
        g_player.look(xOffset, yOffset);
    }
}

// GLFW key state is level-triggered (GLFW_PRESS for as long as it's held);
// mode/perspective toggles need edge detection so holding the key doesn't
// flip the state every frame.
bool consumeKeyPress(GLFWwindow* window, int key, bool& wasDown) {
    const bool isDown = glfwGetKey(window, key) == GLFW_PRESS;
    const bool justPressed = isDown && !wasDown;
    wasDown = isDown;
    return justPressed;
}

bool consumeMouseButtonPress(GLFWwindow* window, int button, bool& wasDown) {
    const bool isDown = glfwGetMouseButton(window, button) == GLFW_PRESS;
    const bool justPressed = isDown && !wasDown;
    wasDown = isDown;
    return justPressed;
}

fgp::PlayerInput gatherPlayerInput(GLFWwindow* window) {
    fgp::PlayerInput input;
    if (glfwGetKey(window, GLFW_KEY_W) == GLFW_PRESS) input.moveAxis.y += 1.0f;
    if (glfwGetKey(window, GLFW_KEY_S) == GLFW_PRESS) input.moveAxis.y -= 1.0f;
    if (glfwGetKey(window, GLFW_KEY_D) == GLFW_PRESS) input.moveAxis.x += 1.0f;
    if (glfwGetKey(window, GLFW_KEY_A) == GLFW_PRESS) input.moveAxis.x -= 1.0f;
    input.jumpPressed = glfwGetKey(window, GLFW_KEY_SPACE) == GLFW_PRESS;
    return input;
}

void processNonMovementInput(GLFWwindow* window, float deltaTime, fgp::World& world) {
    // Escape's first job is "give me my mouse back" (the reflex for that is
    // universal); it only quits once the cursor is already free, so it
    // can't be mistaken for an instant-quit while captured.
    if (consumeKeyPress(window, GLFW_KEY_ESCAPE, g_escapeKeyWasDown)) {
        if (g_cursorFree) {
            glfwSetWindowShouldClose(window, true);
        } else {
            g_cursorFree = true;
            glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
            g_firstMouse = true;
        }
    }

    if (consumeKeyPress(window, GLFW_KEY_V, g_perspectiveKeyWasDown)) {
        g_camera.togglePerspective();
    }

    // GLFW_CURSOR_DISABLED hides and locks the OS pointer for mouselook,
    // which also makes it impossible to grab the window's edges/titlebar to
    // resize or move it. Left Alt releases the cursor for that (and any
    // other window-manager interaction), same convention as many games use
    // for "let me use my desktop for a second".
    if (consumeKeyPress(window, GLFW_KEY_LEFT_ALT, g_cursorFreeKeyWasDown)) {
        g_cursorFree = !g_cursorFree;
        glfwSetInputMode(window, GLFW_CURSOR, g_cursorFree ? GLFW_CURSOR_NORMAL : GLFW_CURSOR_DISABLED);
        // Avoid a big look-snap from the accumulated cursor delta while free.
        g_firstMouse = true;
    }

    // Clicking back into the viewport re-captures the mouse, the same
    // "click to focus" convention most windowed FPS games use — so the
    // window starts fully resizable/movable and only grabs the cursor once
    // you actually click into it to play. Always poll the button (rather
    // than short-circuiting on g_cursorFree) so the wasDown edge state
    // doesn't go stale while captured.
    const bool leftClickJustPressed = consumeMouseButtonPress(window, GLFW_MOUSE_BUTTON_LEFT, g_captureClickWasDown);
    bool capturedThisFrame = false;
    if (g_cursorFree && leftClickJustPressed) {
        g_cursorFree = false;
        glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_DISABLED);
        g_firstMouse = true;
        capturedThisFrame = true;
    }

    // '-'/'=' (the unshifted keys sharing a slot with '_'/'+') adjust FOV
    // live so it can be dialed in by eye rather than guessed at in code.
    if (glfwGetKey(window, GLFW_KEY_MINUS) == GLFW_PRESS) {
        g_camera.fovDegrees -= kFovAdjustDegreesPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_EQUAL) == GLFW_PRESS) {
        g_camera.fovDegrees += kFovAdjustDegreesPerSecond * deltaTime;
    }
    g_camera.fovDegrees = std::clamp(g_camera.fovDegrees, kMinFovDegrees, kMaxFovDegrees);
    if (consumeKeyPress(window, GLFW_KEY_R, g_ragballKeyWasDown)) {
        g_player.toggleMode(world);
        // Ragball defaults to third-person (seeing the ball roll is the
        // point); Walking defaults back to first-person. V still overrides
        // either way regardless of mode.
        g_camera.setPerspective(g_player.mode() == fgp::PlayerMode::Ragball ? fgp::CameraPerspective::ThirdPerson
                                                                             : fgp::CameraPerspective::FirstPerson);
    }

    g_digCooldown -= deltaTime;
    // Digging is a Walking-mode action; there's no tool/hand free to swing
    // while tucked into a ball. Also disabled while the cursor is free, and
    // on the frame that click recaptured it — that click just re-focuses
    // the window rather than aiming at anything.
    const bool canDig = !g_cursorFree && !capturedThisFrame && g_player.mode() == fgp::PlayerMode::Walking &&
                         glfwGetMouseButton(window, GLFW_MOUSE_BUTTON_LEFT) == GLFW_PRESS;
    if (canDig) {
        if (g_digCooldown <= 0.0f) {
            const glm::vec3 origin = g_player.eyePosition();
            const glm::vec3 direction = g_player.front();

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
    glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
#endif

    // Exclusive fullscreen at the desktop's native resolution — sidesteps
    // window-manager edge-drag resizing entirely (its hit region proved too
    // fiddly to use, on top of the cursor-capture interactions above).
    GLFWmonitor* monitor = glfwGetPrimaryMonitor();
    const GLFWvidmode* mode = monitor ? glfwGetVideoMode(monitor) : nullptr;
    const int windowWidth = mode ? mode->width : kInitialWidth;
    const int windowHeight = mode ? mode->height : kInitialHeight;
    if (mode) {
        glfwWindowHint(GLFW_RED_BITS, mode->redBits);
        glfwWindowHint(GLFW_GREEN_BITS, mode->greenBits);
        glfwWindowHint(GLFW_BLUE_BITS, mode->blueBits);
        glfwWindowHint(GLFW_REFRESH_RATE, mode->refreshRate);
    }

    GLFWwindow* window = glfwCreateWindow(windowWidth, windowHeight, "fatguyphysics", monitor, nullptr);
    if (!window) {
        std::fprintf(stderr, "failed to create window\n");
        glfwTerminate();
        return EXIT_FAILURE;
    }

    glfwMakeContextCurrent(window);
    // Starts free/visible (see g_cursorFree) — click into the viewport to
    // capture it for mouselook.
    glfwSetInputMode(window, GLFW_CURSOR, GLFW_CURSOR_NORMAL);
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
        fgp::HudText hudFov;
        fgp::HudText hudFps;
        fgp::HudText hudDist;

        fgp::Texture cobbleTexture(fgp::executableDir() / "assets" / "textures" / "cobble.png");
        fgp::Texture whiteTexture(fgp::executableDir() / "assets" / "textures" / "white.png");
        fgp::Texture bushTexture(fgp::executableDir() / "assets" / "billboard" / "bush.png");
        shader.use();
        shader.setInt("uTexture", 0);

        fgp::World world(/*seed=*/1337);

        // Placeholder player body — see PlayerMesh.hpp. Uploaded once; a
        // unit sphere is reused every frame via uModel (translate * rotate
        // * scale), same as chunks reuse their mesh via translate.
        fgp::ChunkMesh playerMesh;
        playerMesh.upload(fgp::buildPlayerSphereMesh(kPlayerBodyColor));

        float lastFrameTime = static_cast<float>(glfwGetTime());
        float accumulator = 0.0f;

        while (!glfwWindowShouldClose(window)) {
            const float currentFrameTime = static_cast<float>(glfwGetTime());
            const float frameTime = std::min(currentFrameTime - lastFrameTime, kMaxFrameTime);
            lastFrameTime = currentFrameTime;

            if (frameTime > 0.0f) {
                const float instantFps = 1.0f / frameTime;
                g_fpsSmoothed = g_fpsSmoothed <= 0.0f ? instantFps
                                                       : glm::mix(g_fpsSmoothed, instantFps, kFpsSmoothing);
            }

            processNonMovementInput(window, frameTime, world);
            const fgp::PlayerInput input = gatherPlayerInput(window);

            // Stream chunks around the player before stepping physics, so
            // this frame's collision queries see terrain rather than the
            // "unloaded" default.
            world.update(g_player.feetPosition());

            accumulator += frameTime;
            int substeps = 0;
            while (accumulator >= kFixedTimestep && substeps < kMaxSubsteps) {
                g_player.update(input, kFixedTimestep, world);
                accumulator -= kFixedTimestep;
                ++substeps;
            }
            if (substeps == kMaxSubsteps) {
                // Dropped time after a huge spike rather than spiraling.
                accumulator = 0.0f;
            }

            g_camera.sync(g_player, world);

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

            // Cross-quad billboards (see Vegetation.cpp): each is only
            // wound for one side, same as the placeholder player mesh below,
            // so face culling has to be off for both sides to render.
            bushTexture.bind(0);
            glDisable(GL_CULL_FACE);
            world.drawBushes(shader);
            glEnable(GL_CULL_FACE);

            if (g_camera.perspective() == fgp::CameraPerspective::ThirdPerson) {
                const glm::mat4 model = glm::translate(glm::mat4(1.0f), g_player.bodyCenter()) *
                                         glm::mat4_cast(g_player.bodyOrientation()) *
                                         glm::scale(glm::mat4(1.0f), glm::vec3(g_player.bodyRadius()));
                shader.setMat4("uModel", model);
                whiteTexture.bind(0);
                // Placeholder art only — not worth hand-verifying winding for.
                glDisable(GL_CULL_FACE);
                playerMesh.draw();
                glEnable(GL_CULL_FACE);
            }

            glDisable(GL_DEPTH_TEST);
            // HudText's screen-space quads aren't wound consistently with GL's
            // default CCW front face, so without this they get silently
            // back-face culled (Crosshair draws GL_LINES, which face culling
            // never touches, so it was rendering fine while this wasn't).
            glDisable(GL_CULL_FACE);
            crosshair.draw(crosshairShader, width, height);

            const auto hudHit = fgp::raycastVoxel(world, g_player.eyePosition(), g_player.front(), kHudRaycastReachMeters);
            std::string distText = "DIST:--";
            if (hudHit) {
                const glm::vec3 hitCenter = (glm::vec3(*hudHit) + 0.5f) * fgp::kVoxelSize;
                const int distMeters = static_cast<int>(std::lround(glm::distance(g_player.eyePosition(), hitCenter)));
                distText = "DIST:" + std::to_string(distMeters);
            }

            const std::string fovText = "FOV:" + std::to_string(static_cast<int>(std::lround(g_camera.fovDegrees)));
            const std::string fpsText = "FPS:" + std::to_string(static_cast<int>(std::lround(g_fpsSmoothed)));
            hudFov.draw(crosshairShader, fovText, width, height, kHudMarginX, kHudMarginX);
            hudFps.draw(crosshairShader, fpsText, width, height, kHudMarginX, kHudMarginX + kHudLineHeight);
            hudDist.draw(crosshairShader, distText, width, height, kHudMarginX, kHudMarginX + 2 * kHudLineHeight);
            glEnable(GL_CULL_FACE);
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
