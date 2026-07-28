#pragma once

#include <vector>

#include "ChunkMesher.hpp"

namespace fgp {

// Owns the GPU-side buffers for one chunk's mesh. Upload replaces the
// buffer contents in place so a re-meshed chunk (post-excavation, later)
// can reuse the same GL objects instead of allocating new ones.
class ChunkMesh {
public:
    ChunkMesh();
    ~ChunkMesh();

    ChunkMesh(const ChunkMesh&) = delete;
    ChunkMesh& operator=(const ChunkMesh&) = delete;
    ChunkMesh(ChunkMesh&&) = delete;
    ChunkMesh& operator=(ChunkMesh&&) = delete;

    void upload(const std::vector<Vertex>& vertices);
    void draw() const;

private:
    unsigned int vao_ = 0;
    unsigned int vbo_ = 0;
    int vertexCount_ = 0;
};

} // namespace fgp
