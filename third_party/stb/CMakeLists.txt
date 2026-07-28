# Vendored single-header image loader (public domain / MIT, see stb_image.h).
# https://github.com/nothings/stb
#
# stb_image.h requires STB_IMAGE_IMPLEMENTATION defined in exactly one
# translation unit; stb_image_impl.cpp is that unit, built once into a small
# static lib so consumers just #include "stb_image.h" with no macro needed.

add_library(stb_image STATIC stb_image_impl.cpp)
target_include_directories(stb_image PUBLIC .)
