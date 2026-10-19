#include "Inventory.hpp"

#include <algorithm>

namespace fgp {

bool Inventory::tryAdd(ItemType type, int count) {
    for (int i = 1; i < kTotalSlots; ++i) {
        auto& slot = slots_[static_cast<std::size_t>(i)];
        if (slot && slot->type == type) {
            slot->count += count;
            return true;
        }
    }
    for (int i = 1; i < kTotalSlots; ++i) {
        auto& slot = slots_[static_cast<std::size_t>(i)];
        if (!slot) {
            slot = ItemStack{type, count};
            return true;
        }
    }
    return false;
}

void Inventory::selectHotbarSlot(int index) {
    selectedHotbarSlot_ = std::clamp(index, 0, kHotbarSlots - 1);
}

std::optional<ItemType> Inventory::selectedItemType() const {
    const auto& s = slots_[static_cast<std::size_t>(selectedHotbarSlot_)];
    return s ? std::optional<ItemType>(s->type) : std::nullopt;
}

bool Inventory::tryConsumeSelected(int count) {
    auto& s = slots_[static_cast<std::size_t>(selectedHotbarSlot_)];
    if (!s || s->count < count) {
        return false;
    }
    s->count -= count;
    if (s->count <= 0) {
        s = std::nullopt;
    }
    return true;
}

} // namespace fgp
