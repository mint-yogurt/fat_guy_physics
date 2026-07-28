# Vendored, pre-generated GL 3.3 core loader (see README.md in this directory
# for how to regenerate). Building it as a static lib here means downstream
# builds never need Python/glad installed.

add_library(glad STATIC src/gl.c)
target_include_directories(glad PUBLIC include)
target_link_libraries(glad PUBLIC ${CMAKE_DL_LIBS})
