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

} // namespace fgp
