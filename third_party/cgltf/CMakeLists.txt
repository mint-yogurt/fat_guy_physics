# Vendored single-header glTF 2.0 parser (MIT, see cgltf.h).
# https://github.com/jkuhlmann/cgltf
#
# cgltf.h requires CGLTF_IMPLEMENTATION defined in exactly one translation
# unit; cgltf_impl.c is that unit, built once into a small static lib so
# consumers just #include "cgltf.h" with no macro needed.

add_library(cgltf STATIC cgltf_impl.c)
target_include_directories(cgltf PUBLIC .)
