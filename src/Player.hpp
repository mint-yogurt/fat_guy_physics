#pragma once

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

namespace fgp {

class World;

enum class PlayerMode { Walking, Ragball };

// Per-frame movement intent, gathered from input before Player::update runs
// so movement logic stays independent of GLFW.
struct PlayerInput {
    glm::vec2 moveAxis{0.0f}; // x = strafe right (+), y = forward (+)
    bool jumpPressed = false;
};

// Physics + look state for the player. Position is tracked as the collider's
// bottom (feet) in both modes, so toggling Ragball doesn't shift the point
// touching the ground. Walking uses an AABB (see voxel/Collision.hpp);
// Ragball uses a sphere. Nothing outside this class needs to know which.
class Player {
public:
    explicit Player(glm::vec3 feetPosition);

    void look(float xOffset, float yOffset);
    void update(const PlayerInput& input, float dt, const World& world);

    // A discrete, once-per-press action — deliberately not part of
    // PlayerInput/update(). update() runs once per fixed physics substep
    // (usually 2+ per real frame), so a level-triggered "toggle" field there
    // would flip the mode back and forth within a single frame and appear
    // to do nothing.
    //
    // Needs World because Walking's box is taller than Ragball's sphere at
    // the same feet position — switching back while under low clearance
    // (e.g. a tunnel scooped just wide enough for the ball) would otherwise
    // embed the box in solid terrain, which the sweep-based collision has no
    // way to recover from (it only ever prevents new penetration, not an
    // existing one) and reads as movement being blocked on every axis.
    void toggleMode(const World& world);

    PlayerMode mode() const { return mode_; }
    bool grounded() const { return grounded_; }

    glm::vec3 feetPosition() const { return position_; }
    glm::vec3 eyePosition() const;
    // Center of the placeholder body mesh (see main.cpp), for third-person
    // rendering.
    glm::vec3 bodyCenter() const;
    float bodyRadius() const;
    glm::quat bodyOrientation() const { return orientation_; }

    glm::vec3 front() const { return front_; }
    glm::vec3 up() const { return up_; }
    glm::vec3 right() const { return right_; }

    static constexpr float kWalkHalfWidth = 0.3f;
    static constexpr float kWalkHeight = 1.9f; // 190cm player
    static constexpr float kWalkEyeHeight = 1.78f; // eyes sit just below the top of the head
    static constexpr float kRagballRadius = 0.4f;

    // Below the loaded vertical chunk band there's no terrain to catch a
    // fall (see World.hpp's kVerticalChunkMin), so anything that drops out
    // the bottom just respawns. This is a stopgap for testing movement, not
    // a designed mechanic — expect it to be replaced (fall damage, a void
    // biome, whatever) once that's actually decided.
    static constexpr float kKillPlaneY = -5.0f;

    float mouseSensitivity = 0.1f;
    float walkSpeed = 4.5f;
    float jumpSpeed = 6.3f;
    // Ragball is momentum-based (see DESIGN.md): input should only nudge/
    // steer, not directly drive speed the way Walking does. Real speed is
    // meant to come from rolling downhill under gravity, so ragballAccel is
    // deliberately weak and ragballMaxSpeed is a high safety ceiling (against
    // runaway velocity on steep terrain), not a normal-play cap.
    float ragballAccel = 3.0f;
    float ragballMaxSpeed = 20.0f;

private:
    void updateVectors();
    void updateWalking(const PlayerInput& input, float dt, const World& world);
    void updateRagball(const PlayerInput& input, float dt, const World& world);
    void updateBodyOrientation(float dt);
    void respawnIfBelowKillPlane(const World& world);

    glm::vec3 position_; // feet
    glm::vec3 velocity_{0.0f};
    PlayerMode mode_ = PlayerMode::Walking;
    bool grounded_ = false;
    glm::quat orientation_{1.0f, 0.0f, 0.0f, 0.0f};

    glm::vec3 front_{0.0f, 0.0f, -1.0f};
    glm::vec3 up_{0.0f, 1.0f, 0.0f};
    glm::vec3 right_{1.0f, 0.0f, 0.0f};
    glm::vec3 worldUp_{0.0f, 1.0f, 0.0f};
    float yaw_ = -90.0f;
    float pitch_ = 0.0f;
};

} // namespace fgp
