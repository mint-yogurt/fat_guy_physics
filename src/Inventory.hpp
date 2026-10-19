#pragma once

#include <array>
#include <optional>

namespace fgp {

enum class ItemType { Stick, Leaf, Log };
constexpr int kItemTypeCount = 3;

struct ItemStack {
    ItemType type;
    int count;
};

// Minecraft-style hotbar + backpack. Slot 0 is always "Unarmed" (no
// ItemStack — see isUnarmedSelected) representing the player's default
// bare-handed state, which is what scoop/chup require to be selected (see
// main.cpp's canDig/canChup). Slots [1, kHotbarSlots) are the rest of the
// always-visible hotbar; [kHotbarSlots, kTotalSlots) is the backpack,
// only shown in the B-key pop-up.
class Inventory {
public:
    static constexpr int kHotbarSlots = 8;
    static constexpr int kBackpackSlots = 16;
    static constexpr int kTotalSlots = kHotbarSlots + kBackpackSlots;

    // Adds to an existing stack of the same type if one exists, otherwise
    // the first empty slot (hotbar before backpack, never slot 0). Returns
    // false if no room (every slot occupied by a different type).
    bool tryAdd(ItemType type, int count = 1);

    int selectedHotbarSlot() const { return selectedHotbarSlot_; }
    void selectHotbarSlot(int index);
    bool isUnarmedSelected() const { return selectedHotbarSlot_ == 0; }

    // nullopt for slot 0 (Unarmed) or an empty slot. index must be in
    // [0, kTotalSlots).
    const std::optional<ItemStack>& slot(int index) const { return slots_[static_cast<std::size_t>(index)]; }

    // Type of the item in the currently selected hotbar slot, or nullopt if
    // Unarmed (slot 0, always empty by invariant) or the slot is empty.
    std::optional<ItemType> selectedItemType() const;

    // Removes count from the currently selected hotbar slot's stack,
    // clearing the slot if it hits zero. Returns false (no-op) if the
    // selection is Unarmed/empty/holds fewer than count — callers must
    // check the return value before doing anything the consumption was
    // supposed to gate (e.g. spawning a thrown stick).
    bool tryConsumeSelected(int count = 1);

private:
    std::array<std::optional<ItemStack>, kTotalSlots> slots_{};
    int selectedHotbarSlot_ = 0;
};

} // namespace fgp
