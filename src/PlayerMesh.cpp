#include "PlayerMesh.hpp"

#include <algorithm>
#include <cmath>

#include <cgltf.h>
#include <glm/gtc/type_ptr.hpp>

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

std::optional<std::vector<Vertex>> loadPlayerMeshFromGltf(const std::filesystem::path& path, glm::vec3 color,
                                                            int mirrorAxis) {
    if (!std::filesystem::exists(path)) {
        return std::nullopt;
    }

    cgltf_options options{};
    cgltf_data* data = nullptr;
    if (cgltf_parse_file(&options, path.string().c_str(), &data) != cgltf_result_success) {
        return std::nullopt;
    }
    // Resolves and reads external/embedded buffers referenced by accessors;
    // without this, accessor reads below would see null data even though
    // parsing itself succeeded.
    if (cgltf_load_buffers(&options, data, path.string().c_str()) != cgltf_result_success) {
        cgltf_free(data);
        return std::nullopt;
    }

    std::vector<Vertex> vertices;

    // Iterate every node with a mesh directly (rather than walking the
    // scene graph) so nothing is missed if a node isn't reachable from the
    // default scene; cgltf_node_transform_world walks each node's own
    // ancestor chain regardless of which scene(s) reference it.
    for (cgltf_size nodeIdx = 0; nodeIdx < data->nodes_count; ++nodeIdx) {
        const cgltf_node& node = data->nodes[nodeIdx];
        if (node.mesh == nullptr) {
            continue;
        }

        float worldMatrixArr[16];
        cgltf_node_transform_world(&node, worldMatrixArr);
        const glm::mat4 worldMatrix = glm::make_mat4(worldMatrixArr);
        const glm::mat3 normalMatrix = glm::mat3(worldMatrix);

        const cgltf_mesh& mesh = *node.mesh;
        for (cgltf_size primIdx = 0; primIdx < mesh.primitives_count; ++primIdx) {
            const cgltf_primitive& prim = mesh.primitives[primIdx];
            if (prim.type != cgltf_primitive_type_triangles) {
                continue;
            }

            const cgltf_accessor* positionAccessor = nullptr;
            const cgltf_accessor* normalAccessor = nullptr;
            const cgltf_accessor* uvAccessor = nullptr;
            for (cgltf_size attrIdx = 0; attrIdx < prim.attributes_count; ++attrIdx) {
                const cgltf_attribute& attr = prim.attributes[attrIdx];
                if (attr.type == cgltf_attribute_type_position) {
                    positionAccessor = attr.data;
                } else if (attr.type == cgltf_attribute_type_normal) {
                    normalAccessor = attr.data;
                } else if (attr.type == cgltf_attribute_type_texcoord && attr.index == 0) {
                    uvAccessor = attr.data;
                }
            }
            if (positionAccessor == nullptr) {
                continue;
            }

            const cgltf_size vertexCount = positionAccessor->count;
            std::vector<glm::vec3> localPositions(vertexCount);
            std::vector<glm::vec3> localNormals(vertexCount, glm::vec3(0.0f, 1.0f, 0.0f));
            std::vector<glm::vec2> uvs(vertexCount, glm::vec2(0.0f));

            for (cgltf_size v = 0; v < vertexCount; ++v) {
                float p[3];
                cgltf_accessor_read_float(positionAccessor, v, p, 3);
                localPositions[v] = glm::vec3(p[0], p[1], p[2]);

                if (normalAccessor != nullptr) {
                    float n[3];
                    cgltf_accessor_read_float(normalAccessor, v, n, 3);
                    localNormals[v] = glm::vec3(n[0], n[1], n[2]);
                }
                if (uvAccessor != nullptr) {
                    float uv[2];
                    cgltf_accessor_read_float(uvAccessor, v, uv, 2);
                    uvs[v] = glm::vec2(uv[0], uv[1]);
                }
            }

            std::vector<cgltf_uint> indices;
            if (prim.indices != nullptr) {
                indices.resize(prim.indices->count);
                cgltf_accessor_unpack_indices(prim.indices, indices.data(), sizeof(cgltf_uint), indices.size());
            } else {
                // Non-indexed primitive: positions are already in
                // draw-order triangle triples.
                indices.resize(vertexCount);
                for (cgltf_size i = 0; i < vertexCount; ++i) {
                    indices[i] = static_cast<cgltf_uint>(i);
                }
            }

            // Transforms one (position, normal) pair from local mesh space
            // into world space and appends every indexed triangle vertex.
            auto emit = [&](const std::vector<glm::vec3>& positionsLocal, const std::vector<glm::vec3>& normalsLocal) {
                vertices.reserve(vertices.size() + indices.size());
                for (cgltf_uint index : indices) {
                    const glm::vec3 worldPosition = glm::vec3(worldMatrix * glm::vec4(positionsLocal[index], 1.0f));
                    const glm::vec3 worldNormal = glm::normalize(normalMatrix * normalsLocal[index]);
                    vertices.push_back({worldPosition, color, uvs[index], worldNormal});
                }
            };

            emit(localPositions, localNormals);

            if (mirrorAxis >= 0 && mirrorAxis <= 2) {
                // Rebuilds the other half of a mesh authored with an
                // unapplied Mirror modifier: reflect every vertex across
                // the given axis in local mesh space (matching where the
                // modifier itself would have generated geometry, before
                // this node's own rotation/translation is applied below).
                // Winding isn't flipped to match — main.cpp draws the
                // player mesh with face culling disabled, so it doesn't
                // matter which way the mirrored triangles wind.
                std::vector<glm::vec3> mirroredPositions = localPositions;
                std::vector<glm::vec3> mirroredNormals = localNormals;
                for (cgltf_size v = 0; v < vertexCount; ++v) {
                    mirroredPositions[v][mirrorAxis] *= -1.0f;
                    mirroredNormals[v][mirrorAxis] *= -1.0f;
                }
                emit(mirroredPositions, mirroredNormals);
            }
        }
    }

    cgltf_free(data);

    if (vertices.empty()) {
        return std::nullopt;
    }

    // Recenter on the bounding-box center and rescale to a unit-radius
    // bounding sphere — see the header comment for why this has to match
    // buildPlayerSphereMesh's contract.
    glm::vec3 boundsMin = vertices.front().position;
    glm::vec3 boundsMax = vertices.front().position;
    for (const Vertex& vertex : vertices) {
        boundsMin = glm::min(boundsMin, vertex.position);
        boundsMax = glm::max(boundsMax, vertex.position);
    }
    const glm::vec3 center = (boundsMin + boundsMax) * 0.5f;

    float maxDistance = 0.0f;
    for (const Vertex& vertex : vertices) {
        maxDistance = std::max(maxDistance, glm::length(vertex.position - center));
    }
    const float scale = maxDistance > 0.0f ? 1.0f / maxDistance : 1.0f;

    for (Vertex& vertex : vertices) {
        vertex.position = (vertex.position - center) * scale;
    }

    return vertices;
}

} // namespace fgp
