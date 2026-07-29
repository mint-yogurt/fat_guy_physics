#pragma once

#include <array>

#include <glm/glm.hpp>

#include "HudText.hpp"
#include "Inventory.hpp"
#include "Shader.hpp"
#include "Texture.hpp"

namespace fgp {

// Minecraft-style hotbar (always visible, bottom-center) plus a backpack
// grid pop-up (toggled externally — main.cpp binds popupOpen to the B
// key). Icons are individual per-item PNGs (not an atlas), so each slot is
// its own draw call: a shared unit quad transformed per-slot via uniforms
// (assets/shaders/ui_icon.vert), the same "build once, position per draw"
// pattern this project already uses for 3D meshes via uModel.
class Hotbar {
public:
    Hotbar();
    ~Hotbar();

    Hotbar(const Hotbar&) = delete;
    Hotbar& operator=(const Hotbar&) = delete;

    bool popupOpen = false;

    // itemIcons is indexed by ItemType (static_cast<int>) — nullptr entries
    // draw as a blank (empty) slot, icon-less. countTextShader is HudText's
    // usual passthrough shader (main.cpp's crosshairShader); whiteTexture
    // backs each slot's frame/background quad (tinted via uTint) so empty
    // slots and the selected-slot highlight are both visible even with no
    // icon on top — see drawSlot's comment for why a plain icon-brightness
    // tint alone wasn't enough.
    void draw(const Shader& uiShader, const Inventory& inventory, const Texture& whiteTexture,
              const Texture& unarmedIcon, const std::array<const Texture*, kItemTypeCount>& itemIcons,
              const Shader& countTextShader, int framebufferWidth, int framebufferHeight);

private:
    // Draws the slot's background/frame first (always, so an empty slot —
    // and the whole popup, which starts out entirely empty — is still
    // visible) then the icon on top if there is one. uiShader.use() is
    // called here rather than once at the top of draw(): HudText::draw
    // (called mid-loop for stack counts) switches the active GL program
    // internally, and Shader's glUniform* setters act on whatever program
    // is currently bound, not on the Shader object itself — asserting the
    // program per-slot makes that ordering hazard structurally impossible
    // to reintroduce instead of just avoiding it this one time.
    void drawSlot(const Shader& uiShader, glm::vec2 topLeftPixels, glm::vec2 sizePixels, const Texture& whiteTexture,
                  const Texture* icon, bool selected, glm::vec2 framebufferSize) const;

    unsigned int vao_ = 0;
    unsigned int vbo_ = 0;
    HudText countText_;
};

} // namespace fgp
