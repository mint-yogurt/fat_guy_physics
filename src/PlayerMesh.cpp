#include "PlayerMesh.hpp"

#include <cmath>

namespace fgp {

namespace {

glm::vec3 spherePoint(float theta, float phi) {
    return glm::vec3(std::sin(theta) * std::cos(phi), std::cos(theta), std::sin(theta) * std::sin(phi));
}

} // namespace

std::vector<Vertex> buildPlayerSphereMesh(glm::vec3 color, int latSegments, int lonSegments) {
    std::vector<Vertex> vertices;
    vertices.reserve(static_cast<std::size_t>(latSegments) * lonSegments * 6);

    constexpr float kPi = 3.14159265358979323846f;

    for (int i = 0; i < latSegments; ++i) {
        const float theta0 = kPi * static_cast<float>(i) / static_cast<float>(latSegments);
        const float theta1 = kPi * static_cast<float>(i + 1) / static_cast<float>(latSegments);

        for (int j = 0; j < lonSegments; ++j) {
            const float phi0 = 2.0f * kPi * static_cast<float>(j) / static_cast<float>(lonSegments);
            const float phi1 = 2.0f * kPi * static_cast<float>(j + 1) / static_cast<float>(lonSegments);

            const glm::vec3 p00 = spherePoint(theta0, phi0);
            const glm::vec3 p01 = spherePoint(theta0, phi1);
            const glm::vec3 p10 = spherePoint(theta1, phi0);
            const glm::vec3 p11 = spherePoint(theta1, phi1);

            const glm::vec2 uv00(static_cast<float>(j) / lonSegments, static_cast<float>(i) / latSegments);
            const glm::vec2 uv01(static_cast<float>(j + 1) / lonSegments, static_cast<float>(i) / latSegments);
            const glm::vec2 uv10(static_cast<float>(j) / lonSegments, static_cast<float>(i + 1) / latSegments);
            const glm::vec2 uv11(static_cast<float>(j + 1) / lonSegments, static_cast<float>(i + 1) / latSegments);

            // Winding isn't load-bearing here: main.cpp draws the player
            // mesh with face culling disabled, since this is a placeholder
            // body, not geometry worth hand-verifying CCW order for.
            // Unit sphere centered at the origin: position is already the
            // outward normal, no separate computation needed.
            vertices.push_back({p00, color, uv00, p00});
            vertices.push_back({p10, color, uv10, p10});
            vertices.push_back({p11, color, uv11, p11});

            vertices.push_back({p00, color, uv00, p00});
            vertices.push_back({p11, color, uv11, p11});
            vertices.push_back({p01, color, uv01, p01});
        }
    }

    return vertices;
}

} // namespace fgp
