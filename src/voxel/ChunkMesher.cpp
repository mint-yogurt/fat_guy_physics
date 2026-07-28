#include "ChunkMesher.hpp"

namespace fgp {
namespace {

// One potential face between two adjacent voxels along the sweep axis.
// `material` is Air when there's no face (both voxels solid or both air).
struct MaskCell {
    Material material = Material::Air;
    bool backFace = false; // true when the solid voxel is on the +axis side

    bool operator==(const MaskCell& other) const {
        return material == other.material && backFace == other.backFace;
    }
};

Material materialAt(const Chunk& chunk, glm::ivec3 p) {
    if (!Chunk::inBounds(p.x, p.y, p.z)) {
        return Material::Air;
    }
    return chunk.at(p.x, p.y, p.z);
}

void emitQuad(std::vector<Vertex>& out, glm::ivec3 origin, glm::ivec3 du, glm::ivec3 dv, bool backFace, Material material) {
    const glm::vec3 color = materialColor(material);
    const glm::vec3 c0 = glm::vec3(origin) * kVoxelSize;
    const glm::vec3 c1 = glm::vec3(origin + du) * kVoxelSize;
    const glm::vec3 c2 = glm::vec3(origin + du + dv) * kVoxelSize;
    const glm::vec3 c3 = glm::vec3(origin + dv) * kVoxelSize;

    // du/dv have exactly one nonzero (positive) component each, equal to
    // the quad's width/height in voxels; summing components extracts it.
    // UV spans (0,0)-(w,h) so the texture tiles once per voxel via
    // GL_REPEAT instead of stretching across a greedy-meshed quad.
    const float w = static_cast<float>(du.x + du.y + du.z);
    const float h = static_cast<float>(dv.x + dv.y + dv.z);
    const glm::vec2 uv0(0.0f, 0.0f);
    const glm::vec2 uv1(w, 0.0f);
    const glm::vec2 uv2(w, h);
    const glm::vec2 uv3(0.0f, h);

    // (u, v, d) is a cyclic permutation of (x, y, z), so cross(du, dv)
    // points in +d; frontFace quads keep that winding, backFace quads
    // reverse it so the visible normal points toward -d instead.
    if (!backFace) {
        out.push_back({c0, color, uv0});
        out.push_back({c1, color, uv1});
        out.push_back({c2, color, uv2});
        out.push_back({c0, color, uv0});
        out.push_back({c2, color, uv2});
        out.push_back({c3, color, uv3});
    } else {
        out.push_back({c0, color, uv0});
        out.push_back({c2, color, uv2});
        out.push_back({c1, color, uv1});
        out.push_back({c0, color, uv0});
        out.push_back({c3, color, uv3});
        out.push_back({c2, color, uv2});
    }
}

// Greedy-meshes one axis direction (d = 0/1/2 for x/y/z) of the chunk.
void meshAxis(const Chunk& chunk, int d, std::vector<Vertex>& out) {
    const int u = (d + 1) % 3;
    const int v = (d + 2) % 3;

    glm::ivec3 x(0);
    glm::ivec3 q(0);
    q[d] = 1;

    std::vector<MaskCell> mask(static_cast<std::size_t>(kChunkSize) * kChunkSize);

    for (x[d] = -1; x[d] < kChunkSize; ++x[d]) {
        int n = 0;
        for (x[v] = 0; x[v] < kChunkSize; ++x[v]) {
            for (x[u] = 0; x[u] < kChunkSize; ++x[u], ++n) {
                const Material a = materialAt(chunk, x);
                const Material b = materialAt(chunk, x + q);
                const bool aSolid = isSolid(a);
                const bool bSolid = isSolid(b);

                if (aSolid == bSolid) {
                    mask[n] = MaskCell{};
                } else if (aSolid) {
                    mask[n] = MaskCell{a, false};
                } else {
                    mask[n] = MaskCell{b, true};
                }
            }
        }

        // x[d] now marks the plane the mask was built against; the loop's
        // ++x[d] already applied it for the samples above, so the quads
        // generated below use this same value as their plane coordinate.
        const glm::ivec3 plane = x + q;

        n = 0;
        for (int j = 0; j < kChunkSize; ++j) {
            for (int i = 0; i < kChunkSize;) {
                const MaskCell cell = mask[static_cast<std::size_t>(n)];
                if (cell.material == Material::Air) {
                    ++i;
                    ++n;
                    continue;
                }

                int w = 1;
                while (i + w < kChunkSize && mask[static_cast<std::size_t>(n + w)] == cell) {
                    ++w;
                }

                int h = 1;
                bool done = false;
                for (; j + h < kChunkSize; ++h) {
                    for (int k = 0; k < w; ++k) {
                        if (!(mask[static_cast<std::size_t>(n + k + h * kChunkSize)] == cell)) {
                            done = true;
                            break;
                        }
                    }
                    if (done) break;
                }

                glm::ivec3 origin = plane;
                origin[u] = i;
                origin[v] = j;

                glm::ivec3 du(0);
                du[u] = w;
                glm::ivec3 dv(0);
                dv[v] = h;

                emitQuad(out, origin, du, dv, cell.backFace, cell.material);

                for (int l = 0; l < h; ++l) {
                    for (int k = 0; k < w; ++k) {
                        mask[static_cast<std::size_t>(n + k + l * kChunkSize)] = MaskCell{};
                    }
                }

                i += w;
                n += w;
            }
        }
    }
}

} // namespace

std::vector<Vertex> buildChunkMesh(const Chunk& chunk) {
    std::vector<Vertex> vertices;
    for (int d = 0; d < 3; ++d) {
        meshAxis(chunk, d, vertices);
    }
    return vertices;
}

} // namespace fgp
