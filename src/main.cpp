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

#if defined(__linux__)
// X11 key autorepeat delivers a continuous stream of synthetic KeyPress
// events while a key is held — confirmed (via an XTest-driven repro
// isolating this one variable) to starve out cursor-motion event delivery
// on this system, causing look() to stop being called entirely for as
// long as a movement key is held. Suppressing it while the game window
// has focus, restoring it the instant that focus is lost (see
// windowFocusCallback below), fixes that without touching the user's
// desktop otherwise.
#define GLFW_EXPOSE_NATIVE_X11
#include <GLFW/glfw3native.h>
#include <X11/Xlib.h>
#endif

#include "Camera.hpp"
#include "Crosshair.hpp"
#include "HudText.hpp"
#include "Paths.hpp"
#include "Player.hpp"
#include "PlayerMesh.hpp"
#include "PostProcess.hpp"
#include "Shader.hpp"
#include "Texture.hpp"
#include "voxel/ChunkMesh.hpp"
#include "voxel/VoxelRaycast.hpp"
#include "voxel/World.hpp"

namespace {

constexpr int kInitialWidth = 640;
constexpr int kInitialHeight = 360;

constexpr float kDigTickSeconds = 0.35f;
constexpr float kDigReachMeters = 5.0f;
constexpr float kDigRadiusMeters = 0.35f;

// A scoop is a single gesture, not a continuous stream: re-raycasting every
// tick made the dig point creep deeper along the view ray as each tick
// cleared the voxels the previous raycast had stopped at, drilling a tunnel
// instead of hollowing out one spot. So the aim is latched once per gesture
// and only re-raycast once it drifts past these thresholds — small holding
// jitter keeps re-targeting the same already-carved spot, which is a no-op.
constexpr float kDigReanchorPositionEpsilon = 0.05f; // meters
constexpr float kDigReanchorDirectionEpsilon = 0.995f; // cos(angle); ~5.7 degrees

constexpr float kFovAdjustDegreesPerSecond = 40.0f;
constexpr float kMinFovDegrees = 30.0f;
constexpr float kMaxFovDegrees = 120.0f;

// Chromatic aberration offset is in UV space (fraction of screen), so its
// useful range is tiny; color bleed is an additive strength on top of the
// mip-blurred scene, so it can run higher before washing the image out.
// Both sweep their full range in ~2 seconds of holding the key, matching
// the FOV adjustment's feel above.
constexpr float kAberrationAdjustPerSecond = 0.01f;
constexpr float kMinAberration = 0.0f;
constexpr float kMaxAberration = 0.02f;
constexpr float kBleedAdjustPerSecond = 0.5f;
constexpr float kMinBleed = 0.0f;
constexpr float kMaxBleed = 1.0f;

// How far out the crosshair-distance HUD readout looks for something to
// report on; matches the projection's far clip plane so it can report
// anything actually visible.
constexpr float kHudRaycastReachMeters = 100.0f;

// Exponential smoothing factor for the FPS readout — raw 1/frameTime is too
// jittery frame-to-frame to read.
constexpr float kFpsSmoothing = 0.1f;

constexpr int kHudMarginX = 10;
constexpr int kHudLineHeight = 28;

// Fixed-timestep physics: the initial full-radius chunk load is synchronous
// (see World's streaming comment) and can spike a frame by hundreds of ms.
// At 0.1m voxels, integrating a big raw deltaTime in one step would tunnel
// the player through terrain. Substepping at a small fixed dt bounds how far
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
// Accumulated here by cursorPosCallback (which can fire multiple times per
// frame — GLFW drains its whole platform event queue on one glfwPollEvents()
// call) and applied to the player exactly once per frame, right before
// physics runs. This keeps look() off the event-pump's call stack entirely:
// it used to run per-motion-event, so a frame with a burst of queued events
// (e.g. after any stall) did several partial, non-atomic yaw/pitch updates
// instead of one coherent one, and the fixed-timestep substep loop below
// could see front_/right_ change mid-way through queued events it had
// nothing to do with.
glm::vec2 g_lookDelta(0.0f);
float g_digCooldown = 0.0f;
bool g_digAnchored = false;
glm::vec3 g_digAnchorOrigin(0.0f);
glm::vec3 g_digAnchorDirection(0.0f, 0.0f, -1.0f);
bool g_ragballKeyWasDown = false;
bool g_perspectiveKeyWasDown = false;
bool g_cursorFreeKeyWasDown = false;
bool g_captureClickWasDown = false;
bool g_escapeKeyWasDown = false;
// Starts free (visible, unlocked) so the window is immediately resizable/
// movable on launch; a click into the viewport captures it for mouselook.
bool g_cursorFree = true;
float g_fpsSmoothed = 0.0f;
// Worst *unclamped* frame time seen in the last second, in milliseconds.
// The FPS readout above clamps to kMaxFrameTime and heavily smooths, so a
// hitch that lasts a single frame barely moves it — this exists to actually
// see stalls the FPS number can't show.
float g_worstFrameMsInWindow = 0.0f;
float g_worstFrameMsDisplay = 0.0f;
float g_worstFrameWindowElapsed = 0.0f;
// Defaults picked to be visible but not distracting; both are dialable
// in-game with [ / ] (aberration) and ; / ' (bleed).
float g_aberrationStrength = 0.0f;
float g_bleedStrength = 0.12f;

void framebufferSizeCallback(GLFWwindow*, int width, int height) {
    glViewport(0, 0, width, height);
}

#if defined(__linux__)
void setX11AutoRepeat(bool enabled) {
    Display* display = glfwGetX11Display();
    if (display == nullptr) {
        return;
    }
    if (enabled) {
        XAutoRepeatOn(display);
    } else {
        XAutoRepeatOff(display);
    }
}

void windowFocusCallback(GLFWwindow*, int focused) {
    setX11AutoRepeat(focused == GLFW_FALSE);
}
#endif

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
    // movement over the client area shouldn't also spin the camera. Only
    // accumulate here — see g_lookDelta's comment for why it's applied to
    // the player once per frame instead of directly from this callback.
    if (!g_cursorFree) {
        g_lookDelta += glm::vec2(xOffset, yOffset);
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

    // '['/']' dial chromatic aberration, ';'/''' dial color bleed — same
    // hold-to-adjust convention as FOV above, on keys FOV isn't already using.
    if (glfwGetKey(window, GLFW_KEY_LEFT_BRACKET) == GLFW_PRESS) {
        g_aberrationStrength -= kAberrationAdjustPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_RIGHT_BRACKET) == GLFW_PRESS) {
        g_aberrationStrength += kAberrationAdjustPerSecond * deltaTime;
    }
    g_aberrationStrength = std::clamp(g_aberrationStrength, kMinAberration, kMaxAberration);

    if (glfwGetKey(window, GLFW_KEY_SEMICOLON) == GLFW_PRESS) {
        g_bleedStrength -= kBleedAdjustPerSecond * deltaTime;
    }
    if (glfwGetKey(window, GLFW_KEY_APOSTROPHE) == GLFW_PRESS) {
        g_bleedStrength += kBleedAdjustPerSecond * deltaTime;
    }
    g_bleedStrength = std::clamp(g_bleedStrength, kMinBleed, kMaxBleed);
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

            const bool sameAnchor = g_digAnchored &&
                                     glm::distance(origin, g_digAnchorOrigin) <= kDigReanchorPositionEpsilon &&
                                     glm::dot(direction, g_digAnchorDirection) >= kDigReanchorDirectionEpsilon;
            if (!sameAnchor) {
                const auto hit = fgp::raycastVoxel(world, origin, direction, kDigReachMeters);
                if (hit) {
                    g_digAnchored = true;
                    g_digAnchorOrigin = origin;
                    g_digAnchorDirection = direction;
                    const glm::vec3 hitCenter = (glm::vec3(*hit) + 0.5f) * fgp::kVoxelSize;
                    world.digSphere(hitCenter, kDigRadiusMeters);
                } else {
                    g_digAnchored = false;
                }
            }
            g_digCooldown = kDigTickSeconds;
        }
    } else {
        // Resetting to 0 (rather than letting the cooldown run negative)
        // stops a release-then-repress from firing a queued burst of digs.
        // Releasing also drops the anchor so the next press always starts a
        // fresh gesture.
        g_digCooldown = 0.0f;
        g_digAnchored = false;
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
    // Reads relative motion straight from the input device instead of
    // GLFW's default warp-and-diff virtualization for disabled-cursor mode
    // — more accurate in general. No-op whenever cursor mode isn't
    // DISABLED, so it's safe to set once up front rather than toggling it
    // alongside every GLFW_CURSOR change.
    if (glfwRawMouseMotionSupported()) {
        glfwSetInputMode(window, GLFW_RAW_MOUSE_MOTION, GLFW_TRUE);
    }
    glfwSetFramebufferSizeCallback(window, framebufferSizeCallback);
    glfwSetCursorPosCallback(window, cursorPosCallback);
#if defined(__linux__)
    // See setX11AutoRepeat's comment above. Exclusive fullscreen at launch
    // means this window has focus immediately, so turn it off right away
    // rather than waiting for a focus event that's already happened.
    glfwSetWindowFocusCallback(window, windowFocusCallback);
    setX11AutoRepeat(false);
#endif

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
        fgp::Shader postProcessShader(shaderDir / "postprocess.vert", shaderDir / "postprocess.frag");
        fgp::PostProcess postProcess;
        fgp::Crosshair crosshair;
        fgp::HudText hudFov;
        fgp::HudText hudFps;
        fgp::HudText hudWorst;
        fgp::HudText hudDist;
        fgp::HudText hudCa;
        fgp::HudText hudBleed;

        fgp::Texture cobbleTexture(fgp::executableDir() / "assets" / "textures" / "cobble.png");
        fgp::Texture whiteTexture(fgp::executableDir() / "assets" / "textures" / "white.png");
        fgp::Texture bushTexture(fgp::executableDir() / "assets" / "billboard" / "bush.png");
        shader.use();
        shader.setInt("uTexture", 0);

        fgp::World world(/*seed=*/1337);

        // Player body — see PlayerMesh.hpp. Uploaded once; a unit-radius,
        // origin-centered mesh is reused every frame via uModel (translate
        // * rotate * scale), same as chunks reuse their mesh via translate.
        // Loads assets/meshes/playermodel_v1.glb if present, otherwise
        // falls back to the placeholder sphere. Same body doubles as the
        // ragball — the model has no animation yet, so both modes just
        // reuse this static mesh with the rotation driven by physics.
        fgp::ChunkMesh playerMesh;
        const std::filesystem::path playerMeshPath =
            fgp::executableDir() / "assets" / "meshes" / "playermodel_v1.glb";
        // mirrorAxis=2 (Z): the source mesh was authored with an unapplied
        // Mirror modifier, so only half the body is in the file. Blender's
        // Y (its mirror axis) becomes glTF/local Z under the standard
        // Blender->glTF Z-up-to-Y-up axis conversion.
        if (auto loadedMesh = fgp::loadPlayerMeshFromGltf(playerMeshPath, kPlayerBodyColor, /*mirrorAxis=*/2)) {
            playerMesh.upload(*loadedMesh);
        } else {
            playerMesh.upload(fgp::buildPlayerSphereMesh(kPlayerBodyColor));
        }

        float lastFrameTime = static_cast<float>(glfwGetTime());
        float accumulator = 0.0f;

        while (!glfwWindowShouldClose(window)) {
            const float currentFrameTime = static_cast<float>(glfwGetTime());
            const float rawFrameTime = currentFrameTime - lastFrameTime;
            const float frameTime = std::min(rawFrameTime, kMaxFrameTime);
            lastFrameTime = currentFrameTime;

            if (frameTime > 0.0f) {
                const float instantFps = 1.0f / frameTime;
                g_fpsSmoothed = g_fpsSmoothed <= 0.0f ? instantFps
                                                       : glm::mix(g_fpsSmoothed, instantFps, kFpsSmoothing);
            }

            g_worstFrameMsInWindow = std::max(g_worstFrameMsInWindow, rawFrameTime * 1000.0f);
            g_worstFrameWindowElapsed += frameTime;
            if (g_worstFrameWindowElapsed >= 1.0f) {
                g_worstFrameMsDisplay = g_worstFrameMsInWindow;
                g_worstFrameMsInWindow = 0.0f;
                g_worstFrameWindowElapsed = 0.0f;
            }

            processNonMovementInput(window, frameTime, world);

            // Apply this frame's accumulated look delta exactly once, before
            // anything reads front_/right_ (movement input below, then
            // physics) — see g_lookDelta's comment.
            g_player.look(g_lookDelta.x, g_lookDelta.y);
            g_lookDelta = glm::vec2(0.0f);

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

            int width = 0;
            int height = 0;
            glfwGetFramebufferSize(window, &width, &height);
            const float aspect = height > 0 ? static_cast<float>(width) / static_cast<float>(height) : 1.0f;

            // The 3D scene renders into an offscreen target so the
            // chromatic-aberration/color-bleed composite pass below can
            // distort it as a whole; screen-space UI (crosshair, HUD) draws
            // straight to the default framebuffer afterwards, undistorted.
            postProcess.begin(width, height);

            glClearColor(0.53f, 0.72f, 0.86f, 1.0f);
            glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);

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

            // Composite the offscreen scene back to the default framebuffer
            // with chromatic aberration + color bleed applied, before any
            // undistorted screen-space UI draws on top of it.
            postProcess.end(postProcessShader, g_aberrationStrength, g_bleedStrength);

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
            const std::string worstText = "WORST:" + std::to_string(static_cast<int>(std::lround(g_worstFrameMsDisplay)));
            // CA/bleed are fractional (see their ranges above), so scale to
            // whole numbers for this digits-only-friendly HUD font.
            const std::string caText = "CA:" + std::to_string(static_cast<int>(std::lround(g_aberrationStrength * 1000.0f)));
            const std::string bleedText = "BLEED:" + std::to_string(static_cast<int>(std::lround(g_bleedStrength * 100.0f)));
            hudFov.draw(crosshairShader, fovText, width, height, kHudMarginX, kHudMarginX);
            hudFps.draw(crosshairShader, fpsText, width, height, kHudMarginX, kHudMarginX + kHudLineHeight);
            hudWorst.draw(crosshairShader, worstText, width, height, kHudMarginX, kHudMarginX + 2 * kHudLineHeight);
            hudDist.draw(crosshairShader, distText, width, height, kHudMarginX, kHudMarginX + 3 * kHudLineHeight);
            hudCa.draw(crosshairShader, caText, width, height, kHudMarginX, kHudMarginX + 4 * kHudLineHeight);
            hudBleed.draw(crosshairShader, bleedText, width, height, kHudMarginX, kHudMarginX + 5 * kHudLineHeight);
            glEnable(GL_CULL_FACE);
            glEnable(GL_DEPTH_TEST);

            glfwSwapBuffers(window);
            glfwPollEvents();
        }
    }

#if defined(__linux__)
    // Safety net in case the window closed without ever losing focus
    // (the normal path — see windowFocusCallback).
    setX11AutoRepeat(true);
#endif
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
