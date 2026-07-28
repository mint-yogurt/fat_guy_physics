#pragma once

#include <filesystem>

namespace fgp {

// Directory containing the running executable. Assets are copied next to
// the executable at build time (see src/CMakeLists.txt), so resolving paths
// relative to this directory works the same whether the binary was launched
// from an IDE, a build/ subdirectory, or a double-click on Windows.
std::filesystem::path executableDir();

} // namespace fgp
