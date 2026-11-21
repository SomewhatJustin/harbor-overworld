// Inventory messages carried over the presence WebSocket. Every type starts
// with "blort-inventory" so it can't collide with presence's own messages.
// Shared by the browser (link.ts) and the server (inventory-room.ts).

import {
  CONTAINER_SLOTS,
  type ContainerKind,
  isContainerKind,
} from '../loot/containers.ts';
import type { Slot } from './inventory.ts';
import { ITEMS } from './items.ts';

export const HOTBAR_SLOTS = 6;
export const BACKPACK_COLUMNS = 6;
export const BACKPACK_ROWS = 4;
export const BACKPACK_SLOTS = BACKPACK_COLUMNS * BACKPACK_ROWS;

/** "container" is whichever shared inventory this connection has open. */
export const BAG_SIZES = {
  hotbar: HOTBAR_SLOTS,
  backpack: BACKPACK_SLOTS,
  container: CONTAINER_SLOTS,
};
export type Bag = keyof typeof BAG_SIZES;
export type SlotAddress = { bag: Bag; index: number };

export const MESSAGE_PREFIX = 'blort-inventory';

export type InventoryHello = { type: 'blort-inventory-hello'; key: string };
export type InventoryMove = {
  type: 'blort-inventory-move';
  from: SlotAddress;
  to: SlotAddress;
};
export type InventoryGrant = {
  type: 'blort-inventory-grant';
  itemId: string;
  quantity: number;
};
/** Draw the gun in a hotbar slot, or holster it with null. */
export type InventoryEquip = {
  type: 'blort-inventory-equip';
  slot: number | null;
};
/** Open a shared inventory in reach, or close whichever is open with null. */
export type InventoryOpen = {
  type: 'blort-inventory-open';
  container: string | null;
};
export type InventoryRequest =
  | InventoryHello
  | InventoryMove
  | InventoryGrant
  | InventoryEquip
  | InventoryOpen;

/** The shared inventory a connection has open. */
export type OpenContainer = { id: string; kind: ContainerKind; slots: Slot[] };

/** Every container in the world, sent to everyone. */
export type ContainerPlacement = {
  id: string;
  kind: ContainerKind;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Someone is looking inside, so the lid is up. */
  open: boolean;
};
export type InventoryWorld = {
  type: 'blort-inventory-world';
  containers: ContainerPlacement[];
};

export type InventoryState = {
  type: 'blort-inventory';
  hotbar: Slot[];
  backpack: Slot[];
  /** The hotbar slot this connection is holding, if any. */
  held: number | null;
  container: OpenContainer | null;
};

export const PLAYER_KEY_PATTERN = /^[a-f0-9]{32}$/;
export const MAX_GRANT = 999;

type Loose = Record<string, unknown>;

/** A plain object (not null or an array), as parsed from JSON. */
export function isObject(value: unknown): value is Loose {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a parsed presence message belongs to the inventory. */
export function isInventoryMessage(value: unknown): value is Loose {
  return (
    isObject(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith(MESSAGE_PREFIX)
  );
}

function isAddress(value: unknown): value is SlotAddress {
  if (!isObject(value)) return false;
  const { bag, index } = value;
  return (
    (bag === 'hotbar' || bag === 'backpack' || bag === 'container') &&
    typeof index === 'number' &&
    Number.isInteger(index) &&
    index >= 0 &&
    index < BAG_SIZES[bag]
  );
}

/** Validates a browser request on the server. Anything malformed is undefined. */
export function readRequest(value: unknown): InventoryRequest | undefined {
  if (!isInventoryMessage(value)) return undefined;
  switch (value.type) {
    case 'blort-inventory-hello':
      return typeof value.key === 'string' && PLAYER_KEY_PATTERN.test(value.key)
        ? { type: value.type, key: value.key }
        : undefined;
    case 'blort-inventory-move':
      return isAddress(value.from) && isAddress(value.to)
        ? { type: value.type, from: value.from, to: value.to }
        : undefined;
    case 'blort-inventory-grant':
      return typeof value.itemId === 'string' &&
        ITEMS.has(value.itemId) &&
        typeof value.quantity === 'number' &&
        Number.isInteger(value.quantity) &&
        value.quantity >= 1 &&
        value.quantity <= MAX_GRANT
        ? { type: value.type, itemId: value.itemId, quantity: value.quantity }
        : undefined;
    case 'blort-inventory-equip':
      return value.slot === null ||
        (typeof value.slot === 'number' &&
          Number.isInteger(value.slot) &&
          value.slot >= 0 &&
          value.slot < HOTBAR_SLOTS)
        ? { type: value.type, slot: value.slot }
        : undefined;
    case 'blort-inventory-open':
      return value.container === null ||
        (typeof value.container === 'string' && value.container.length <= 64)
        ? { type: value.type, container: value.container }
        : undefined;
    default:
      return undefined;
  }
}

function readSlot(value: unknown): Slot | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const { itemId, quantity } = value;
  if (typeof itemId !== 'string' || !ITEMS.has(itemId)) return undefined;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity))
    return undefined;
  const maxStack = ITEMS.get(itemId)?.maxStack ?? 0;
  if (quantity < 1 || quantity > maxStack) return undefined;
  return { itemId, quantity };
}

/** Reads one bag's slots, from the server's state or its save file. */
export function readSlots(value: unknown, size: number): Slot[] | undefined {
  if (!Array.isArray(value) || value.length !== size) return undefined;
  const slots: Slot[] = [];
  for (const entry of value) {
    const slot = readSlot(entry);
    if (slot === undefined) return undefined;
    slots.push(slot);
  }
  return slots;
}

/** The open container in the server's state message, or null. */
function readOpenContainer(value: unknown): OpenContainer | null {
  if (!isObject(value)) return null;
  const { id, kind } = value;
  const slots = readSlots(value.slots, CONTAINER_SLOTS);
  return typeof id === 'string' && isContainerKind(kind) && slots
    ? { id, kind, slots }
    : null;
}

/** Validates the server's state message in the browser. */
export function readState(value: unknown):
  | {
      hotbar: Slot[];
      backpack: Slot[];
      held: number | null;
      container: OpenContainer | null;
    }
  | undefined {
  if (!isInventoryMessage(value) || value.type !== 'blort-inventory')
    return undefined;
  const hotbar = readSlots(value.hotbar, HOTBAR_SLOTS);
  const backpack = readSlots(value.backpack, BACKPACK_SLOTS);
  const held =
    typeof value.held === 'number' &&
    Number.isInteger(value.held) &&
    value.held >= 0 &&
    value.held < HOTBAR_SLOTS
      ? value.held
      : null;
  const container = readOpenContainer(value.container);
  return hotbar && backpack ? { hotbar, backpack, held, container } : undefined;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Validates the server's container list in the browser. */
export function readWorld(value: unknown): ContainerPlacement[] | undefined {
  if (
    !isInventoryMessage(value) ||
    value.type !== 'blort-inventory-world' ||
    !Array.isArray(value.containers)
  )
    return undefined;
  return value.containers.flatMap((entry: unknown) => {
    if (!isObject(entry)) return [];
    const { id, kind, x, y, z, yaw, open } = entry;
    return typeof id === 'string' &&
      isContainerKind(kind) &&
      finite(x) &&
      finite(y) &&
      finite(z) &&
      finite(yaw) &&
      typeof open === 'boolean'
      ? [{ id, kind, x, y, z, yaw, open }]
      : [];
  });
}
