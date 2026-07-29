include(FetchContent)

set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_INSTALL OFF CACHE BOOL "" FORCE)
# Wayland support needs wayland-scanner at configure time; X11 alone is
# enough for now and keeps the Linux prerequisite list to xorg-dev only.
set(GLFW_BUILD_WAYLAND OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    glfw
    GIT_REPOSITORY https://github.com/glfw/glfw.git
    GIT_TAG 3.4
    GIT_SHALLOW TRUE
)

FetchContent_Declare(
    glm
    GIT_REPOSITORY https://github.com/g-truc/glm.git
    GIT_TAG 1.0.1
    GIT_SHALLOW TRUE
)

# Jolt's Build/CMakeLists.txt is written to double as a top-level file (the
# repo has no root CMakeLists.txt), hence SOURCE_SUBDIR. Its TARGET_* app
# options (unit tests/samples/viewer/etc) are self-guarding — they only
# apply "if we're the root CMakeLists.txt", which is false once pulled in
# here via add_subdirectory, so only ENABLE_INSTALL needs forcing off (it's
# not guarded the same way, and would otherwise add install() rules for a
# vendored dependency we're not installing).
set(ENABLE_INSTALL OFF CACHE BOOL "" FORCE)

# Jolt's default CPU dispatch assumes AVX2/FMA/F16C/LZCNT/TZCNT and compiles
# straight-line code against them (not a runtime-detected fallback path) —
# on hardware without those extensions the binary SIGILLs on first use, it
# doesn't just run slower. Restrict to SSE4.1/4.2 (nearly universal on
# x86-64) so the game actually runs on this dev machine and doesn't assume
# every player's CPU is a recent one either.
set(USE_AVX OFF CACHE BOOL "" FORCE)
set(USE_AVX2 OFF CACHE BOOL "" FORCE)
set(USE_AVX512 OFF CACHE BOOL "" FORCE)
set(USE_LZCNT OFF CACHE BOOL "" FORCE)
set(USE_TZCNT OFF CACHE BOOL "" FORCE)
set(USE_F16C OFF CACHE BOOL "" FORCE)
set(USE_FMADD OFF CACHE BOOL "" FORCE)

FetchContent_Declare(
    jolt
    GIT_REPOSITORY https://github.com/jrouwe/JoltPhysics.git
    GIT_TAG v5.6.0
    GIT_SHALLOW TRUE
    SOURCE_SUBDIR Build
)

FetchContent_MakeAvailable(glfw glm jolt)
