# fat_guy_physics
stupid physics voxel game

See [DESIGN.md](DESIGN.md) for the design document and roadmap.

## Building

Requires CMake 3.21+ and a C++20 compiler. Dependencies (GLFW, GLM) are fetched
automatically at configure time via CMake FetchContent — no package manager
(vcpkg/apt) setup required.

### Linux

GLFW needs X11 development headers to build:

```sh
sudo apt-get install cmake ninja-build xorg-dev
```

Then:

```sh
cmake -B build -G Ninja
cmake --build build
./build/fatguyphysics
```

### Windows 10

Install [CMake](https://cmake.org/download/) and Visual Studio 2022 (with the
"Desktop development with C++" workload). No extra dependencies needed.

```powershell
cmake -B build
cmake --build build --config Debug
build\Debug\fatguyphysics.exe
```

## Development Roadmap

See the [Development Roadmap](DESIGN.md#development-roadmap-readme-added-to-as-each-step-gets-worked-on) section of DESIGN.md.

### Phase 0 — Project setup

- [x] Repository
- [x] Build system (CMake + FetchContent)
- [x] Rendering (OpenGL 3.3 core, GLFW + glad)
- [x] Camera
- [x] Basic application framework
