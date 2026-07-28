#pragma once

#include <glm/glm.hpp>

namespace fgp {

class Player;
class World;

enum class CameraPerspective { FirstPerson, ThirdPerson };

// Turns the player's eye position + look direction into a view matrix. Pure
// rendering concern — Player owns look direction and physics, Camera just
// decides where to put the eye. First-person sits exactly at the player's
// eye; third-person orbits behind at a fixed distance, pulled in by a
// terrain probe so it never clips through solid ground.
class Camera {
public:
    void togglePerspective() {
        perspective_ =
            perspective_ == CameraPerspective::FirstPerson ? CameraPerspective::ThirdPerson : CameraPerspective::FirstPerson;
    }
    void setPerspective(CameraPerspective perspective) { perspective_ = perspective; }
    CameraPerspective perspective() const { return perspective_; }

    // Recomputes position_/target_/up_ from the player's current eye
    // position and look direction. Call once per frame before viewMatrix().
    void sync(const Player& player, const World& world);

    glm::mat4 viewMatrix() const;
    glm::vec3 position() const { return position_; }

    float fovDegrees = 90.0f;
    float thirdPersonDistance = 2.2f;

private:
    CameraPerspective perspective_ = CameraPerspective::FirstPerson;
    glm::vec3 position_{0.0f};
    glm::vec3 target_{0.0f};
    glm::vec3 up_{0.0f, 1.0f, 0.0f};
};

} // namespace fgp
