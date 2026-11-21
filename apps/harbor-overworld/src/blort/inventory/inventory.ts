// A fixed number of item slots, modeled on WinterCoopSurvival's
// UInventoryComponent. Pure logic with no DOM, so it can be unit tested.

import { getItem } from './items.ts';

export type Slot = { itemId: string; quantity: number } | null;

type SlotListener = (index: number) => void;

export class Inventory {
  readonly size: number;
  private readonly slots: Slot[];
  private readonly listeners = new Set<SlotListener>();

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 1)
      throw new Error(`Invalid inventory size ${size}`);
    this.size = size;
    this.slots = Array.from({ length: size }, () => null);
  }

  isValidIndex(index: number) {
    return Number.isInteger(index) && index >= 0 && index < this.size;
  }

  getSlot(index: number): Slot {
    if (!this.isValidIndex(index)) return null;
    const slot = this.slots[index];
    return slot ? { ...slot } : null;
  }

  /**
   * Tops up partial stacks of the item first, then fills empty slots in
   * order. Returns how many didn't fit.
   */
  addItem(itemId: string, quantity: number): number {
    const { maxStack } = getItem(itemId);
    let remaining = Math.max(0, Math.floor(quantity));
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const slot = this.slots[i];
      if (slot?.itemId !== itemId || slot.quantity >= maxStack) continue;
      const added = Math.min(maxStack - slot.quantity, remaining);
      slot.quantity += added;
      remaining -= added;
      this.emit(i);
    }
    for (let i = 0; i < this.size && remaining > 0; i++) {
      if (this.slots[i]) continue;
      const added = Math.min(maxStack, remaining);
      this.slots[i] = { itemId, quantity: added };
      remaining -= added;
      this.emit(i);
    }
    return remaining;
  }

  /** Takes quantity out of one slot. All or nothing. */
  removeItem(index: number, quantity: number): boolean {
    const slot = this.isValidIndex(index) ? this.slots[index] : null;
    if (!slot || !Number.isInteger(quantity) || quantity < 1) return false;
    if (slot.quantity < quantity) return false;
    slot.quantity -= quantity;
    if (slot.quantity === 0) this.slots[index] = null;
    this.emit(index);
    return true;
  }

  /** Copies of every slot, in order. */
  snapshot(): Slot[] {
    return this.slots.map((slot) => (slot ? { ...slot } : null));
  }

  /**
   * Replaces every slot, e.g. with state from the server. Only slots whose
   * contents differ are announced. Extra entries are ignored, missing ones
   * become empty.
   */
  replaceAll(slots: readonly Slot[]) {
    for (let i = 0; i < this.size; i++) {
      const next = slots[i] ?? null;
      const current = this.slots[i];
      if (
        current?.itemId === next?.itemId &&
        current?.quantity === next?.quantity
      )
        continue;
      this.slots[i] = next ? { ...next } : null;
      this.emit(i);
    }
  }

  getItemCount(itemId: string): number {
    let count = 0;
    for (const slot of this.slots)
      if (slot?.itemId === itemId) count += slot.quantity;
    return count;
  }

  /** Calls listener with a slot index whenever that slot changes. */
  onSlotChanged(listener: SlotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(index: number) {
    for (const listener of this.listeners) listener(index);
  }

  /** @internal Used by moveSlot. Doesn't validate. */
  static setSlot(inventory: Inventory, index: number, slot: Slot) {
    inventory.slots[index] = slot;
    inventory.emit(index);
  }
}

/**
 * Whether moving from one slot to another takes the stack without anything
 * coming back: the target is empty or holds the same item. Take-only
 * inventories (loot chests) only allow these moves, so nothing swaps in.
 */
export function canTakeInto(
  from: Inventory,
  fromIndex: number,
  to: Inventory,
  toIndex: number,
): boolean {
  const source = from.getSlot(fromIndex);
  const target = to.getSlot(toIndex);
  return !!source && (!target || target.itemId === source.itemId);
}

/**
 * Moves a stack between any two slots, in the same inventory or different
 * ones. An empty target takes the stack, the same item merges up to its max
 * stack with the rest staying behind, and a different item swaps.
 */
export function moveSlot(
  from: Inventory,
  fromIndex: number,
  to: Inventory,
  toIndex: number,
): boolean {
  if (!from.isValidIndex(fromIndex) || !to.isValidIndex(toIndex)) return false;
  if (from === to && fromIndex === toIndex) return false;
  const source = from.getSlot(fromIndex);
  if (!source) return false;
  const target = to.getSlot(toIndex);

  if (target?.itemId === source.itemId) {
    const { maxStack } = getItem(source.itemId);
    const moved = Math.min(maxStack - target.quantity, source.quantity);
    if (moved <= 0) return false;
    const left = source.quantity - moved;
    Inventory.setSlot(to, toIndex, {
      itemId: target.itemId,
      quantity: target.quantity + moved,
    });
    Inventory.setSlot(
      from,
      fromIndex,
      left > 0 ? { itemId: source.itemId, quantity: left } : null,
    );
    return true;
  }

  Inventory.setSlot(to, toIndex, source);
  Inventory.setSlot(from, fromIndex, target);
  return true;
}
