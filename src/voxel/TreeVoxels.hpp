#pragma once

#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

#include <glm/glm.hpp>
#include <glm/gtc/quaternion.hpp>

#include "ChunkMesh.hpp"
#include "ChunkMesher.hpp"
#include "Voxel.hpp"

namespace fgp {

// A tree's own small voxel grid, in tree-local integer voxel coordinates.
// Grid index `originLocal` is the single origin convention every tree-local
// operation agrees on: it maps to tree-local world-space (0,0,0), i.e. the
// trunk's base/root — the same point VegetationInstance::origin used to
// mean. (The old buildTreeMesh had two different, undocumented origins —
// the trunk box sat at local Y=0 while the canopy grid was offset
// separately — this replaces both with one.)
//
// Trees get their own grid instead of being folded into the terrain
// Chunk grid because generateVegetation places them at a jittered,
// non-voxel-grid-aligned position and lets their canopy overhang the
// owning chunk's column footprint; forcing grid alignment would visibly
// move/reshape every tree already generated.
struct TreeVoxelGrid {
    glm::ivec3 dims{0};
    glm::ivec3 originLocal{0};
    std::vector<Material> cells;

    bool inBounds(glm::ivec3 gridIndex) const {
        return gridIndex.x >= 0 && gridIndex.x < dims.x && gridIndex.y >= 0 && gridIndex.y < dims.y &&
               gridIndex.z >= 0 && gridIndex.z < dims.z;
    }

    // local is tree-local voxel space (0,0,0) == trunk root, NOT a raw grid
    // index — callers never add originLocal themselves.
    Material at(glm::ivec3 local) const {
        const glm::ivec3 g = local + originLocal;
        if (!inBounds(g)) {
            return Material::Air;
        }
        return cells[index(g)];
    }

    void set(glm::ivec3 local, Material material) {
        const glm::ivec3 g = local + originLocal;
        if (!inBounds(g)) {
            return; // callers are expected to stay within generation bounds; silently drop otherwise
        }
        cells[index(g)] = material;
    }

    // Raw grid-index (not tree-local) access for code that already walks
    // the full array directly (meshing, shrinking, severing) rather than
    // looking up one tree-local coordinate at a time.
    std::size_t index(glm::ivec3 g) const {
        return (static_cast<std::size_t>(g.y) * dims.z + static_cast<std::size_t>(g.z)) * dims.x +
               static_cast<std::size_t>(g.x);
    }
};

// One harvestable tree: root position in world space, its voxel grid, the
// mesh built from that grid, and chup (chop) state. Replaces the old
// fire-and-forget VegetationInstance for trees (bushes are unaffected —
// they stay simple decorative billboards).
struct TreeInstance {
    glm::vec3 rootWorld;
    TreeVoxelGrid voxels;
    std::unique_ptr<ChunkMesh> mesh;
    std::uint32_t treeHash = 0; // generateVegetation's placement hash — the TreeId for edit persistence

    int trunkHeightVoxels = 0;   // trunk spans local Y in [0, trunkHeightVoxels)
    float trunkRadiusVoxels = 0.0f;
    bool severed = false;
};

// CPU-only counterpart, matching VegetationPlacement's role for trees: what
// a worker thread produces (no GL calls), before the main thread uploads
// meshVertices into a real ChunkMesh and wraps the result as a
// TreeInstance.
struct TreePlacement {
    glm::vec3 rootWorld;
    TreeVoxelGrid voxels;
    std::vector<Vertex> meshVertices;
    std::uint32_t treeHash = 0;
    int trunkHeightVoxels = 0;
    float trunkRadiusVoxels = 0.0f;
    bool severed = false; // true if regenerated from a previously chup-severed tree (see severedAtLocalY below)
};

// Procedurally voxelizes one tree (cylinder trunk + noise-lobed canopy,
// same shapes/randomization the old buildTreeMesh used) into a
// TreeVoxelGrid, shrunk to its occupied bounding box. If severedAtLocalY is
// set (a previously chup-severed tree streaming back in), only the trunk
// up to that Y is generated — no canopy, matching "stays a stump" — so a
// chunk that streams out and back in doesn't regrow what was cut.
TreePlacement generateTreePlacement(std::uint32_t treeHash, glm::vec3 rootWorld,
                                     std::optional<int> severedAtLocalY);

// Neighbor-culled per-voxel box emission (the same style Vegetation.cpp's
// canopy generation already used) over every occupied cell in the grid.
// Deliberately not routed through ChunkMesher's greedy mesher: that's
// hardcoded to the fixed 32^3 Chunk array, and generalizing it to
// arbitrary dimensions is real work this slice doesn't need — tree edits
// are rare (one chip/sever/scoop at a time) and tree face counts are
// small, so remeshing the whole tree per edit this way is cheap enough.
std::vector<Vertex> buildTreeVoxelMesh(const TreeVoxelGrid& grid);

struct ChopResult {
    // Split by material (rather than one combined list) so the caller can
    // dispatch the right debris material and pickup type per material
    // actually cleared — chup's disc can clear Wood and Leaf in the same
    // swing (e.g. aimed near the trunk/canopy boundary).
    std::vector<glm::ivec3> clearedWoodVoxels;
    std::vector<glm::ivec3> clearedLeafVoxels;
    std::optional<int> severedAtLocalY;         // set if this hit cut all the way through a band
    std::optional<TreeVoxelGrid> severedAbove;  // the piece that fell off, if severedAtLocalY is set
};

// --- Grid-generic operations -----------------------------------------
//
// Everything below operates on a bare TreeVoxelGrid positioned/oriented in
// world space by an explicit (gridPosition, gridRotation) pair, rather than
// assuming a TreeInstance's translation-only rootWorld. This is what lets a
// felled, tumbled DynamicLog (main.cpp) reuse the exact same raycast/dig/
// chop/sever logic a standing tree uses (gridRotation = identity there)
// instead of a parallel duplicate implementation. World<->local conversion
// is localPos = inverse(gridRotation) * (worldPos - gridPosition).
//
// The TreeInstance-specific functions further below (raycastTree etc.) are
// thin wrappers over these.

std::optional<glm::ivec3> raycastVoxelGrid(const TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation,
                                            glm::vec3 originWorld, glm::vec3 direction, float maxDistanceMeters);

// Scoop path: removes Leaf voxels within radiusMeters of centerWorld (Wood
// isn't hand-diggable, see isHandDiggable — chup-only). Returns the cleared
// voxels (grid-local), empty if nothing was there to clear.
std::vector<glm::ivec3> digVoxelGridSphere(TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation,
                                            glm::vec3 centerWorld, float radiusMeters);

// Splits grid at local Y == severLocalY: every voxel at localY >=
// severLocalY is cleared from grid (the piece that remains, shrunk in
// place) and returned as a new grid (the severed piece, also shrunk).
TreeVoxelGrid severVoxelGridAt(TreeVoxelGrid& grid, int severLocalY);

// Chup path: shears voxels out of the grid in a thin horizontal disc (wide
// in X/Z up to horizontalRadiusMeters, thin in Y —
// verticalHalfThicknessMeters — a "slice"/notch, not scoop's fuller
// sphere). Clears anything isChoppable (i.e. anything scoop could
// hand-dig, plus Wood) — chup is a strict superset of scoop, not
// trunk-only. No artificial hit-counter: if this disc happens to clear
// every remaining Wood voxel in one Y-band, the cross-section has nothing
// left holding it together, so the grid is severed there via
// severVoxelGridAt automatically (clearing Leaf never triggers this — only
// Wood is checked).
//
// The severance scan's Y-range is derived from the grid's OWN actual
// occupied-Wood extent (found by scanning grid itself), not a caller-
// supplied bound or an assumed [0, height) range: after rebaseGridToPivot
// (main.cpp) re-centers a piece around its own pivot, its local Y range can
// be negative, so "clamp the scan floor to 0" — which earlier versions of
// this function did — would silently make the lower half of any recentered
// piece unseverable. Pure-canopy Y-bands never contain Wood either way, so
// the derived extent naturally excludes them the same way a caller-supplied
// bound used to.
ChopResult chopVoxelGrid(TreeVoxelGrid& grid, glm::vec3 gridPosition, glm::quat gridRotation, glm::vec3 centerWorld,
                          float horizontalRadiusMeters, float verticalHalfThicknessMeters);

// --- TreeInstance-specific wrappers ------------------------------------

// Tree-local counterpart to VoxelRaycast's raycastVoxel: DDA against the
// tree's own grid instead of the terrain. Returns the hit voxel in
// tree-local coordinates (add rootWorld back to get world space), or
// nullopt.
std::optional<glm::ivec3> raycastTree(const TreeInstance& tree, glm::vec3 originWorld, glm::vec3 direction,
                                       float maxDistanceMeters);

// See digVoxelGridSphere — the caller remeshes only if the result is
// non-empty, and can spawn per-voxel debris at each returned position.
std::vector<glm::ivec3> digTreeSphere(TreeInstance& tree, glm::vec3 centerWorld, float radiusMeters);

// See severVoxelGridAt. Also marks tree.severed and lowers
// tree.trunkHeightVoxels to severLocalY. Caller is responsible for
// remeshing tree.mesh from tree.voxels afterward.
TreeVoxelGrid severTreeAt(TreeInstance& tree, int severLocalY);

// See chopVoxelGrid. Also updates tree.severed/tree.trunkHeightVoxels if
// this chop severed the tree. Repeated hits at roughly the same spot
// naturally take several passes to fully clear a thicker trunk's band,
// which is what gives "many hits without a tool" its feel — there's no
// separate counter enforcing it.
ChopResult chopTree(TreeInstance& tree, glm::vec3 centerWorld, float horizontalRadiusMeters,
                     float verticalHalfThicknessMeters);

} // namespace fgp
