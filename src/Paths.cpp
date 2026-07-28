#include "Paths.hpp"

#include <stdexcept>

#if defined(_WIN32)
#include <windows.h>
#elif defined(__linux__)
#include <unistd.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

namespace fgp {

std::filesystem::path executableDir() {
#if defined(_WIN32)
    wchar_t path[MAX_PATH];
    DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (len == 0 || len == MAX_PATH) {
        throw std::runtime_error("failed to resolve executable path");
    }
    return std::filesystem::path(path, path + len).parent_path();
#elif defined(__linux__)
    char path[4096];
    ssize_t len = readlink("/proc/self/exe", path, sizeof(path) - 1);
    if (len == -1) {
        throw std::runtime_error("failed to resolve executable path");
    }
    path[len] = '\0';
    return std::filesystem::path(path).parent_path();
#elif defined(__APPLE__)
    char path[4096];
    uint32_t size = sizeof(path);
    if (_NSGetExecutablePath(path, &size) != 0) {
        throw std::runtime_error("failed to resolve executable path");
    }
    return std::filesystem::canonical(path).parent_path();
#else
#error "executableDir() not implemented for this platform"
#endif
}

} // namespace fgp
