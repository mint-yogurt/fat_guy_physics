#pragma once

#include <filesystem>

#include <glm/glm.hpp>

namespace fgp {

class Shader {
public:
    Shader(const std::filesystem::path& vertexPath, const std::filesystem::path& fragmentPath);
    ~Shader();

    Shader(const Shader&) = delete;
    Shader& operator=(const Shader&) = delete;

    void use() const;
    void setMat4(const char* name, const glm::mat4& value) const;
    void setInt(const char* name, int value) const;
    void setFloat(const char* name, float value) const;

private:
    unsigned int id_ = 0;
};

} // namespace fgp
