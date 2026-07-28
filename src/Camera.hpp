#pragma once

#include <glm/glm.hpp>

namespace fgp {

enum class CameraMove { Forward, Backward, Left, Right, Up, Down };

// Free-flying debug camera (yaw/pitch, no roll). Movement is decoupled from
// input handling so it can be driven from tests or a future replay system.
class Camera {
public:
    explicit Camera(glm::vec3 position = glm::vec3(0.0f, 2.0f, 6.0f));

    void move(CameraMove direction, float deltaTime);
    void look(float xOffset, float yOffset);

    glm::mat4 viewMatrix() const;
    glm::vec3 position() const { return position_; }
    glm::vec3 front() const { return front_; }

    float fovDegrees = 70.0f;
    float moveSpeed = 5.0f;
    float mouseSensitivity = 0.1f;

private:
    void updateVectors();

    glm::vec3 position_;
    glm::vec3 front_ = glm::vec3(0.0f, 0.0f, -1.0f);
    glm::vec3 up_ = glm::vec3(0.0f, 1.0f, 0.0f);
    glm::vec3 right_ = glm::vec3(1.0f, 0.0f, 0.0f);
    glm::vec3 worldUp_ = glm::vec3(0.0f, 1.0f, 0.0f);

    float yaw_ = -90.0f;
    float pitch_ = 0.0f;
};

} // namespace fgp
