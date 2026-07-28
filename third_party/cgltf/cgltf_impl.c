// cgltf.h requires CGLTF_IMPLEMENTATION defined in exactly one translation
// unit; this is that unit, built once into a small static lib so consumers
// just #include "cgltf.h" with no macro needed (mirrors third_party/stb).
#define CGLTF_IMPLEMENTATION
#include "cgltf.h"
