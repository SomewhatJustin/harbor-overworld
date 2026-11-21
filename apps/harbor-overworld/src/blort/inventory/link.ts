// The browser's end of the inventory: borrows the presence WebSocket (see the
// hooks in src/world/presence.ts), sends requests over it and hands the
// server's state to whoever is listening. One shared object per page.

import type { Slot } from './inventory.ts';
import {
  type ContainerPlacement,
  type InventoryRequest,
  type OpenContainer,
  isInventoryMessage,
  PLAYER_KEY_PATTERN,
  readState,
  readWorld,
  type SlotAddress,
} from './protocol.ts';

export type InventorySnapshot = {
  hotbar: Slot[];
  backpack: Slot[];
  /** Hotbar slot whose gun this tab is holding. */
  held: number | null;
  /** The chest this tab has open, if any. */
  container: OpenContainer | null;
};

const KEY_STORAGE = 'blort.inventory.player-key';

function playerKey() {
  const fresh = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored && PLAYER_KEY_PATTERN.test(stored)) return stored;
    localStorage.setItem(KEY_STORAGE, fresh);
  } catch {
    // Storage blocked: this page load gets its own inventory.
  }
  return fresh;
}

function createInventoryLink() {
  let socket: WebSocket | undefined;
  let key: string | undefined;
  let online = false;
  const stateListeners = new Set<(state: InventorySnapshot) => void>();
  const worldListeners = new Set<(containers: ContainerPlacement[]) => void>();
  const onlineListeners = new Set<(online: boolean) => void>();

  function setOnline(next: boolean) {
    if (online === next) return;
    online = next;
    for (const listener of onlineListeners) listener(online);
  }

  function send(request: InventoryRequest) {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(request));
    return true;
  }

  return {
    /** Presence calls this once its socket is welcomed into the room. */
    attach(connection: WebSocket) {
      socket = connection;
      key ??= playerKey();
      send({ type: 'blort-inventory-hello', key });
    },

    /** Presence calls this with every parsed message. True means "mine". */
    receive(message: unknown): boolean {
      if (!isInventoryMessage(message)) return false;
      const state = readState(message);
      if (state) {
        setOnline(true);
        for (const listener of stateListeners) listener(state);
      }
      const containers = readWorld(message);
      if (containers)
        for (const listener of worldListeners) listener(containers);
      return true;
    },

    /** Presence calls this when its socket closes. */
    detach() {
      socket = undefined;
      setOnline(false);
    },

    get online() {
      return online;
    },

    move(from: SlotAddress, to: SlotAddress) {
      return send({ type: 'blort-inventory-move', from, to });
    },

    /** Draws the gun in a hotbar slot, or holsters it with null. */
    equip(slot: number | null) {
      return send({ type: 'blort-inventory-equip', slot });
    },

    /** Opens a chest in reach, or closes the open one with null. */
    open(container: string | null) {
      return send({ type: 'blort-inventory-open', container });
    },

    /** Playground only: the server ignores this anywhere else. */
    grant(itemId: string, quantity = 1) {
      return send({ type: 'blort-inventory-grant', itemId, quantity });
    },

    onState(listener: (state: InventorySnapshot) => void) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    /** Every container in the world, whenever one changes. */
    onWorld(listener: (containers: ContainerPlacement[]) => void) {
      worldListeners.add(listener);
      return () => worldListeners.delete(listener);
    },

    onOnline(listener: (online: boolean) => void) {
      onlineListeners.add(listener);
      return () => onlineListeners.delete(listener);
    },
  };
}

export const inventoryLink = createInventoryLink();
