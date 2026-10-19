// Golden-data dumper: writes reference output from the C++ implementation so
// the TypeScript port can be asserted against it.
//
// This is NOT part of the game build. It compiles headlessly against the real
// voxel sources (no GL, no GLFW, no Jolt) via tools/golden/dump-golden.sh,
// which also extracts hash32/hashFloat straight out of Vegetation.cpp into
// hash_extracted.inc -- those two live in an anonymous namespace and cannot
// be linked against, and hand-copying them would defeat the entire purpose of
// a golden test by reintroducing the transcription error it exists to catch.
//
// Why this exists: a 7000-line port has a thousand places to introduce a 1%
// difference, and the ones that matter most are silent. The FNV hash is the
// worst of them -- get the 32-bit multiply wrong in JS and every tree in the
// world moves somewhere else, deterministically and plausibly, forever.

#include <cstdint>
#include <cstdio>
#include <vector>

#include "../../src/voxel/Chunk.hpp"
#include "../../src/voxel/ChunkMesher.hpp"
#include "../../src/voxel/TerrainGenerator.hpp"
#include "../../src/voxel/Voxel.hpp"

// Collision.cpp and Player.cpp are compiled against tools/golden/stub/World.hpp
// rather than the real one -- see that header for why, and dump-golden.sh for
// how. The sources themselves are unmodified.
#include "World.hpp"
#include "Player.hpp"

namespace {
#include "hash_extracted.inc"
} // namespace

namespace {

constexpr int kSeed = 1337;

// Chosen to cover every structurally distinct case the generator produces at
// this seed: a fully-solid deep layer, the partially-filled band below the
// surface, the surface itself (the only genuinely complex mesh), pure air
// above it, and negative coordinates -- which exercise floorDiv/floorMod,
// where C++'s truncating division would silently differ from a naive port.
// Layer 1 (voxel Y 32..63) is used for the negative-coordinate cases rather
// than layer 2: the generator's height range is baseHeight 64 +/- 24, so a
// layer-2 chunk is empty wherever the surface happens to fall below Y=64 --
// which is exactly what the first pick did, giving two chunks that asserted
// nothing. Layer 1 is partially filled everywhere.
const glm::ivec3 kChunkCoords[] = {
    {0, 0, 0},    // deep: uniform solid, boundary faces only
    {0, 1, 0},    // below surface: material banding
    {0, 2, 0},    // surface band: the genuinely complex mesh
    {0, 3, 0},    // above surface: expected empty
    {1, 2, 0},    // surface, neighbouring column
    {0, 2, 1},    //
    {-1, 1, -1},  // negative coords
    {5, 1, -3},   //
};

// %.9g round-trips a float32 exactly, so the JSON carries the full precision
// the C++ actually computed rather than a rounded-off version of it.
void printFloat(std::FILE* out, float v) { std::fprintf(out, "%.9g", static_cast<double>(v)); }

void dumpHashes(std::FILE* out) {
    std::fprintf(out, "  \"hash\": [\n");
    bool first = true;
    // A deliberate spread: zeros, small values, values straddling the sign
    // bit, and values above 2^31 (where JS's signed bitwise ops and C++'s
    // uint32 arithmetic are most likely to part ways).
    const std::uint32_t samples[] = {0u,          1u,          2u,          7u,         255u,
                                      256u,       65535u,      65536u,      1000003u,   0x7FFFFFFFu,
                                      0x80000000u, 0x80000001u, 0xFFFFFFFFu, 0xDEADBEEFu, 1337u};
    const int n = static_cast<int>(sizeof(samples) / sizeof(samples[0]));
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j < n; ++j) {
            // The full 15x15 cross product. ~225 tuples is still only ~16KB
            // of JSON, and every one of them is a chance to catch the
            // 32-bit-multiply bug on a bit pattern the others miss.
            const std::uint32_t a = samples[i];
            const std::uint32_t b = samples[j];
            const std::uint32_t c = samples[(i + j) % n];
            const std::uint32_t d = samples[(i * 2 + 1) % n];
            if (!first) std::fprintf(out, ",\n");
            first = false;
            std::fprintf(out, "    {\"a\":%u,\"b\":%u,\"c\":%u,\"d\":%u,\"h\":%u,\"f\":", a, b, c, d,
                          hash32(a, b, c, d));
            printFloat(out, hashFloat(a, b, c, d));
            std::fprintf(out, "}");
        }
    }
    std::fprintf(out, "\n  ],\n");
}

void dumpSurfaceHeights(std::FILE* out, const fgp::TerrainGenerator& gen) {
    std::fprintf(out, "  \"surfaceHeight\": [\n");
    bool first = true;
    for (int x = -40; x <= 40; x += 7) {
        for (int z = -40; z <= 40; z += 13) {
            if (!first) std::fprintf(out, ",\n");
            first = false;
            std::fprintf(out, "    {\"x\":%d,\"z\":%d,\"h\":%d}", x, z, gen.surfaceHeight(x, z));
        }
    }
    std::fprintf(out, "\n  ],\n");
}

void dumpChunks(std::FILE* out, const fgp::TerrainGenerator& gen) {
    std::fprintf(out, "  \"chunks\": [\n");
    for (std::size_t i = 0; i < sizeof(kChunkCoords) / sizeof(kChunkCoords[0]); ++i) {
        const glm::ivec3 coord = kChunkCoords[i];
        fgp::Chunk chunk(coord);
        gen.generate(chunk);

        // A cheap order-sensitive digest of the voxel contents, so a
        // generation mismatch is reported separately from a meshing
        // mismatch instead of the two being conflated.
        std::uint32_t voxelDigest = 2166136261u;
        for (int z = 0; z < fgp::kChunkSize; ++z) {
            for (int y = 0; y < fgp::kChunkSize; ++y) {
                for (int x = 0; x < fgp::kChunkSize; ++x) {
                    voxelDigest ^= static_cast<std::uint32_t>(chunk.at(x, y, z));
                    voxelDigest *= 16777619u;
                }
            }
        }

        const std::vector<fgp::Vertex> verts = fgp::buildChunkMesh(chunk);

        if (i > 0) std::fprintf(out, ",\n");
        std::fprintf(out, "    {\"coord\":[%d,%d,%d],\"voxelDigest\":%u,\"vertexCount\":%zu,\"vertices\":[",
                      coord.x, coord.y, coord.z, voxelDigest, verts.size());
        for (std::size_t v = 0; v < verts.size(); ++v) {
            const fgp::Vertex& vert = verts[v];
            if (v > 0) std::fprintf(out, ",");
            const float f[11] = {vert.position.x, vert.position.y, vert.position.z,
                                  vert.color.x,    vert.color.y,    vert.color.z,
                                  vert.uv.x,       vert.uv.y,       vert.normal.x,
                                  vert.normal.y,   vert.normal.z};
            for (int k = 0; k < 11; ++k) {
                if (k > 0) std::fprintf(out, ",");
                printFloat(out, f[k]);
            }
        }
        std::fprintf(out, "]}");
    }
    std::fprintf(out, "\n  ]\n");
}

} // namespace


// ---------------------------------------------------------------------------
// Player + collision trace
//
// Collision.cpp is the most behaviourally fragile file in the project: a
// dozen hand-tuned epsilons, an asymmetric floor/ceil bias, and a step-up
// search whose exit conditions were arrived at empirically. A port of it
// that is 99% right is indistinguishable from one that is 100% right until
// someone walks into a specific ledge at a specific angle.
//
// So rather than testing the sweep functions in isolation, this drives the
// real Player through a scripted input sequence -- walking into slopes,
// jumping, toggling into Ragball and rolling -- and records the full state
// every substep. Any divergence in epsilon handling, axis ordering, or
// step-up logic shows up as a position that drifts apart from the
// reference's within a few hundred substeps.

namespace {

struct ScriptSegment {
    int substeps;
    float moveX;
    float moveZ;
    bool jump;      // fired on the first substep of the segment only
    bool toggle;    // mode toggle, applied before the segment runs
    float lookYaw;  // mouse X offset applied before the segment runs
};

// Deliberately varied: straight walking into rising terrain, strafing,
// diagonal approaches (where the step-up assist's "blocked axes only" rule
// matters), a jump, and a long Ragball roll where sweepSphere's iterative
// push-out and slide response take over.
const ScriptSegment kScript[] = {
    {60, 0.0f, 1.0f, false, false, 0.0f},     // walk forward onto terrain
    {60, 0.0f, 1.0f, true, false, 0.0f},      // jump while walking
    {90, 1.0f, 1.0f, false, false, 0.0f},     // diagonal: step-up assist
    {60, 0.0f, 1.0f, false, false, 400.0f},   // turn 40 degrees, keep going
    {90, -1.0f, 1.0f, false, false, 0.0f},    // opposite diagonal
    {30, 0.0f, 0.0f, false, false, 0.0f},     // stand still, settle
    {240, 0.0f, 1.0f, false, true, 0.0f},     // Ragball: roll under gravity
    {120, 1.0f, 0.0f, false, false, 0.0f},    // steer the ball
    {60, 0.0f, 0.0f, false, true, 0.0f},      // back to Walking (unstuck lift)
    {60, 0.0f, 1.0f, false, false, 0.0f},
};

constexpr float kFixedTimestep = 1.0f / 120.0f;

void dumpPlayerTrace(std::FILE* out) {
    const fgp::World world(kSeed);

    // Spawn directly above the generator's surface at the origin, matching
    // what the client does.
    const float spawnY = static_cast<float>(world.surfaceHeightVoxels(0, 0)) * fgp::kVoxelSize + 2.0f;
    fgp::Player player(glm::vec3(0.0f, spawnY, 0.0f));

    std::fprintf(out, ",\n  \"playerTrace\": {\n");
    std::fprintf(out, "    \"spawnY\": ");
    printFloat(out, spawnY);
    std::fprintf(out, ",\n    \"fixedTimestep\": ");
    printFloat(out, kFixedTimestep);
    std::fprintf(out, ",\n    \"script\": [\n");

    bool firstSeg = true;
    for (const ScriptSegment& seg : kScript) {
        if (!firstSeg) std::fprintf(out, ",\n");
        firstSeg = false;
        std::fprintf(out, "      {\"n\":%d,\"mx\":", seg.substeps);
        printFloat(out, seg.moveX);
        std::fprintf(out, ",\"mz\":");
        printFloat(out, seg.moveZ);
        std::fprintf(out, ",\"jump\":%s,\"toggle\":%s,\"yaw\":", seg.jump ? "true" : "false",
                     seg.toggle ? "true" : "false");
        printFloat(out, seg.lookYaw);
        std::fprintf(out, "}");
    }
    std::fprintf(out, "\n    ],\n    \"steps\": [\n");

    bool firstStep = true;
    for (const ScriptSegment& seg : kScript) {
        if (seg.toggle) {
            player.toggleMode(world);
        }
        if (seg.lookYaw != 0.0f) {
            player.look(seg.lookYaw, 0.0f);
        }

        for (int i = 0; i < seg.substeps; ++i) {
            fgp::PlayerInput input;
            input.moveAxis = glm::vec2(seg.moveX, seg.moveZ);
            input.jumpPressed = seg.jump && i == 0;
            player.update(input, kFixedTimestep, world);

            if (!firstStep) std::fprintf(out, ",\n");
            firstStep = false;

            const glm::vec3 p = player.feetPosition();
            std::fprintf(out, "      [");
            printFloat(out, p.x);
            std::fprintf(out, ",");
            printFloat(out, p.y);
            std::fprintf(out, ",");
            printFloat(out, p.z);
            std::fprintf(out, ",%d,%d]", player.grounded() ? 1 : 0,
                         player.mode() == fgp::PlayerMode::Walking ? 0 : 1);
        }
    }
    std::fprintf(out, "\n    ]\n  }\n");
}

} // namespace
int main(int argc, char** argv) {
    const char* path = (argc > 1) ? argv[1] : "golden.json";
    std::FILE* out = std::fopen(path, "wb");
    if (out == nullptr) {
        std::fprintf(stderr, "cannot open %s for writing\n", path);
        return 1;
    }

    const fgp::TerrainGenerator gen(kSeed);

    std::fprintf(out, "{\n");
    std::fprintf(out, "  \"seed\": %d,\n", kSeed);
    std::fprintf(out, "  \"voxelSize\": ");
    printFloat(out, fgp::kVoxelSize);
    std::fprintf(out, ",\n  \"chunkSize\": %d,\n", fgp::kChunkSize);
    dumpHashes(out);
    dumpSurfaceHeights(out, gen);
    dumpChunks(out, gen);
    dumpPlayerTrace(out);
    std::fprintf(out, "}\n");

    std::fclose(out);
    std::fprintf(stderr, "wrote %s\n", path);
    return 0;
}
