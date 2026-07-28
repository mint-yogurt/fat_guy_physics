#include "Camera.hpp"

#include <algorithm>

#include <glm/gtc/matrix_transform.hpp>

namespace fgp {

Camera::Camera(glm::vec3 position) : position_(position) {
    updateVectors();
}

void Camera::move(CameraMove direction, float deltaTime) {
    const float velocity = moveSpeed * deltaTime;
    switch (direction) {
        case CameraMove::Forward:  position_ += front_ * velocity; break;
        case CameraMove::Backward: position_ -= front_ * velocity; break;
        case CameraMove::Left:     position_ -= right_ * velocity; break;
        case CameraMove::Right:    position_ += right_ * velocity; break;
        case CameraMove::Up:       position_ += worldUp_ * velocity; break;
        case CameraMove::Down:     position_ -= worldUp_ * velocity; break;
    }
}

void Camera::look(float xOffset, float yOffset) {
    yaw_ += xOffset * mouseSensitivity;
    pitch_ += yOffset * mouseSensitivity;
    pitch_ = std::clamp(pitch_, -89.0f, 89.0f);
    updateVectors();
}

glm::mat4 Camera::viewMatrix() const {
    return glm::lookAt(position_, position_ + front_, up_);
}

void Camera::updateVectors() {
    const float yawRad = glm::radians(yaw_);
    const float pitchRad = glm::radians(pitch_);

    glm::vec3 direction;
    direction.x = std::cos(yawRad) * std::cos(pitchRad);
    direction.y = std::sin(pitchRad);
    direction.z = std::sin(yawRad) * std::cos(pitchRad);
    front_ = glm::normalize(direction);
    right_ = glm::normalize(glm::cross(front_, worldUp_));
    up_ = glm::normalize(glm::cross(right_, front_));
}

} // namespace fgp
