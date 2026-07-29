#include "Hotbar.hpp"

#include <cstddef>
#include <string>

#include <glad/gl.h>

namespace fgp {

namespace {
constexpr float kSlotSize = 48.0f;
constexpr float kSlotSpacing = 4.0f;
constexpr float kHotbarBottomMargin = 16.0f;

constexpr float kPopupSlotSize = 40.0f;
constexpr float kPopupSlotSpacing = 4.0f;
constexpr float kPopupBottomMargin = 90.0f; // sits above the hotbar row
constexpr int kPopupColumns = 8;

// Slot background/frame quad tint, drawn behind every slot (occupied or
// not) so the popup has visible chrome even before anything's in the
// backpack, and so "selected" has a highlight to show even on an empty or
// icon-less slot.
const glm::vec4 kSlotBackgroundTint(0.15f, 0.15f, 0.15f, 0.55f);
const glm::vec4 kSlotBackgroundSelectedTint(0.55f, 0.55f, 0.2f, 0.75f);
const glm::vec4 kIconTint(1.0f, 1.0f, 1.0f, 1.0f);
} // namespace

Hotbar::Hotbar() {
    // Unit quad in [0,1]^2 (screen-space: position.y grows downward),
    // position+uv interleaved. uv.y is flipped relative to position.y:
    // Texture always loads with stbi_set_flip_vertically_on_load(true), so
    // row 0 of the decoded pixel buffer is the BOTTOM of the source image
    // (v=0 there), matching GL's bottom-origin texture convention. Screen
    // pixel space grows the other way (y=0 at the top), so the slot's
    // on-screen top edge (position.y=0) must sample the image's top (v=1),
    // not v=0 — otherwise every icon draws vertically flipped.
    const float verts[] = {
        0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 0.0f, 1.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f, 1.0f, 1.0f, 1.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f,
    };
    glGenVertexArrays(1, &vao_);
    glGenBuffers(1, &vbo_);
    glBindVertexArray(vao_);
    glBindBuffer(GL_ARRAY_BUFFER, vbo_);
    glBufferData(GL_ARRAY_BUFFER, sizeof(verts), verts, GL_STATIC_DRAW);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<void*>(0));
    glEnableVertexAttribArray(0);
    glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 4 * sizeof(float), reinterpret_cast<void*>(2 * sizeof(float)));
    glEnableVertexAttribArray(1);
    glBindVertexArray(0);
}

Hotbar::~Hotbar() {
    glDeleteBuffers(1, &vbo_);
    glDeleteVertexArrays(1, &vao_);
}

void Hotbar::drawSlot(const Shader& uiShader, glm::vec2 topLeftPixels, glm::vec2 sizePixels,
                      const Texture& whiteTexture, const Texture* icon, bool selected,
                      glm::vec2 framebufferSize) const {
    // Re-assert the program every call (see the header comment on this
    // function) rather than relying on the caller having left it bound —
    // HudText::draw switches the active program internally and this is the
    // only thing that makes that safe to interleave with.
    uiShader.use();
    uiShader.setInt("uTexture", 0);
    uiShader.setVec2("uSlotPixelPos", topLeftPixels);
    uiShader.setVec2("uSlotPixelSize", sizePixels);
    uiShader.setVec2("uFramebufferSize", framebufferSize);
    glBindVertexArray(vao_);

    uiShader.setVec4("uTint", selected ? kSlotBackgroundSelectedTint : kSlotBackgroundTint);
    whiteTexture.bind(0);
    glDrawArrays(GL_TRIANGLES, 0, 6);

    if (icon) {
        uiShader.setVec4("uTint", kIconTint);
        icon->bind(0);
        glDrawArrays(GL_TRIANGLES, 0, 6);
    }
}

void Hotbar::draw(const Shader& uiShader, const Inventory& inventory, const Texture& whiteTexture,
                   const Texture& unarmedIcon, const std::array<const Texture*, kItemTypeCount>& itemIcons,
                   const Shader& countTextShader, int framebufferWidth, int framebufferHeight) {
    const glm::vec2 framebufferSize(static_cast<float>(framebufferWidth), static_cast<float>(framebufferHeight));

    glEnable(GL_BLEND);
    glBlendFunc(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA);
    glDisable(GL_DEPTH_TEST);

    const auto drawGrid = [&](int startSlotIndex, int count, int columns, float slotSize, float spacing,
                               float startX, float startY, bool allowHighlight) {
        for (int i = 0; i < count; ++i) {
            const int col = columns > 0 ? i % columns : i;
            const int row = columns > 0 ? i / columns : 0;
            const glm::vec2 pos(startX + static_cast<float>(col) * (slotSize + spacing),
                                 startY + static_cast<float>(row) * (slotSize + spacing));
            const int slotIndex = startSlotIndex + i;

            if (slotIndex == 0) {
                drawSlot(uiShader, pos, glm::vec2(slotSize), whiteTexture, &unarmedIcon,
                         allowHighlight && inventory.selectedHotbarSlot() == 0, framebufferSize);
                continue;
            }

            const auto& stack = inventory.slot(slotIndex);
            const bool selected = allowHighlight && slotIndex < Inventory::kHotbarSlots &&
                                   inventory.selectedHotbarSlot() == slotIndex;
            if (!stack) {
                drawSlot(uiShader, pos, glm::vec2(slotSize), whiteTexture, nullptr, selected, framebufferSize);
                continue;
            }
            const Texture* icon = itemIcons[static_cast<std::size_t>(stack->type)];
            drawSlot(uiShader, pos, glm::vec2(slotSize), whiteTexture, icon, selected, framebufferSize);
            if (icon && stack->count > 1) {
                const int textMarginX = static_cast<int>(pos.x + slotSize - 14.0f);
                const int textMarginY = static_cast<int>(pos.y + slotSize - 12.0f);
                countText_.draw(countTextShader, std::to_string(stack->count), framebufferWidth, framebufferHeight,
                                 textMarginX, textMarginY, 2);
            }
        }
    };

    const float hotbarWidth =
        Inventory::kHotbarSlots * kSlotSize + static_cast<float>(Inventory::kHotbarSlots - 1) * kSlotSpacing;
    const float hotbarStartX = (framebufferSize.x - hotbarWidth) * 0.5f;
    const float hotbarY = framebufferSize.y - kHotbarBottomMargin - kSlotSize;
    drawGrid(0, Inventory::kHotbarSlots, Inventory::kHotbarSlots, kSlotSize, kSlotSpacing, hotbarStartX, hotbarY,
             /*allowHighlight=*/true);

    if (popupOpen) {
        const float popupWidth =
            kPopupColumns * kPopupSlotSize + static_cast<float>(kPopupColumns - 1) * kPopupSlotSpacing;
        const float popupStartX = (framebufferSize.x - popupWidth) * 0.5f;
        const int rows = (Inventory::kBackpackSlots + kPopupColumns - 1) / kPopupColumns;
        const float popupStartY =
            framebufferSize.y - kPopupBottomMargin - static_cast<float>(rows) * (kPopupSlotSize + kPopupSlotSpacing);
        drawGrid(Inventory::kHotbarSlots, Inventory::kBackpackSlots, kPopupColumns, kPopupSlotSize, kPopupSlotSpacing,
                 popupStartX, popupStartY, /*allowHighlight=*/false);
    }

    glDisable(GL_BLEND);
}

} // namespace fgp
