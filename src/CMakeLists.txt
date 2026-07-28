add_executable(fatguyphysics
    main.cpp
    Camera.cpp
    Player.cpp
    PlayerMesh.cpp
    Shader.cpp
    PostProcess.cpp
    Paths.cpp
    Crosshair.cpp
    HudText.cpp
    Texture.cpp
    voxel/Voxel.cpp
    voxel/ChunkMesher.cpp
    voxel/ChunkMesh.cpp
    voxel/TerrainGenerator.cpp
    voxel/Vegetation.cpp
    voxel/World.cpp
    voxel/VoxelRaycast.cpp
    voxel/Collision.cpp
)

find_package(Threads REQUIRED)
target_link_libraries(fatguyphysics PRIVATE glfw glad glm::glm fastnoiselite stb_image cgltf Threads::Threads)
fgp_set_warnings(fatguyphysics)

if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
    # Suppressing X11 key autorepeat while focused (see main.cpp's
    # setX11AutoRepeat) calls Xlib directly, not just through GLFW's API.
    find_package(X11 REQUIRED)
    target_link_libraries(fatguyphysics PRIVATE X11::X11)
endif()

if(WIN32)
    # Console output (std::cout) is convenient for a prototype; switch to
    # WIN32_EXECUTABLE once a real logging system replaces it.
    target_compile_definitions(fatguyphysics PRIVATE _USE_MATH_DEFINES NOMINMAX WIN32_LEAN_AND_MEAN)
endif()

# Keep assets next to the executable so relative asset lookups work the same
# way under single-config (Ninja/Make) and multi-config (Visual Studio)
# generators, whose output directories differ.
add_custom_command(TARGET fatguyphysics POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_directory
        ${CMAKE_SOURCE_DIR}/assets
        $<TARGET_FILE_DIR:fatguyphysics>/assets
)
