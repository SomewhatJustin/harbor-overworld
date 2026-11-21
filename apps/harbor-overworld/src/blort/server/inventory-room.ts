// Server-side inventories: each browser's own bags, keyed by its player key,
// and the shared containers placed in the world (chests and loot chests).
// The presence server hands us every inventory message from its sockets (see
// the hook in server/presence.ts); everything else about inventories lives
// here.

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canTakeInto, Inventory, moveSlot } from '../inventory/inventory.ts';
import { GUN_ITEM_ID } from '../inventory/items.ts';
import {
  BACKPACK_SLOTS,
  type Bag,
  type ContainerPlacement,
  HOTBAR_SLOTS,
  type InventoryState,
  type InventoryWorld,
  isInventoryMessage,
  isObject,
  PLAYER_KEY_PATTERN,
  readRequest,
  readSlots,
  type SlotAddress,
} from '../inventory/protocol.ts';
import {
  CONTAINER_SLOTS,
  CONTAINERS,
  type ContainerDefinition,
  containerPosition,
  withinReach,
} from '../loot/containers.ts';
import { isLootTableId, LOOT_TABLES, rollLoot } from '../loot/tables.ts';

/** The part of a WebSocket the room uses. */
export type InventorySocket = { send(data: string): void };

type PlayerBag = Exclude<Bag, 'container'>;
type Bags = Record<PlayerBag, Inventory>;
type Player = { bags: Bags; sockets: Set<InventorySocket>; saved: boolean };
type Container = {
  definition: ContainerDefinition;
  slots: Inventory;
  /** A loot container has rolled its loot table. */
  looted: boolean;
};
type Connection = {
  key?: string;
  windowStart: number;
  count: number;
  /** Hotbar slot whose gun this connection is holding. */
  held?: number;
  /** Id of the container this connection has open. */
  open?: string;
};
type Feet = { x: number; y: number; z: number };

export type InventoryRoomOptions = {
  /** JSON file to load from and save to. Memory only when unset. */
  file?: string;
  /** Accept 'grant' requests. Playground only. */
  allowGrants?: boolean;
  /** Containers in the world. Defaults to the live (non-playground) ones. */
  containers?: readonly ContainerDefinition[];
  /**
   * Where a socket's player is standing. Containers only open in reach.
   * Without it, reach isn't checked.
   */
  positionOf?: (socket: InventorySocket) => Feet | undefined;
  /** What new players start with. Defaults to STARTER_KIT. */
  starterKit?: readonly StarterItem[];
  /** Loot rolls. Defaults to Math.random. */
  random?: () => number;
  /** Most inventories kept in the save file. Later keys aren't saved. */
  maxSaved?: number;
  saveDelayMs?: number;
  messagesPerSecond?: number;
  now?: () => number;
};

export type StarterItem = { bag: PlayerBag; itemId: string; quantity: number };

/** What a brand-new player starts with: nothing. Guns come from chests. */
export const STARTER_KIT: readonly StarterItem[] = [];

function newBags(): Bags {
  return {
    hotbar: new Inventory(HOTBAR_SLOTS),
    backpack: new Inventory(BACKPACK_SLOTS),
  };
}

function isEmpty(bags: Bags) {
  return Object.values(bags).every((bag) =>
    bag.snapshot().every((slot) => slot === null),
  );
}

function loadFile(file: string | undefined) {
  const players = new Map<string, Bags>();
  const containers = new Map<string, { slots: Inventory; looted: boolean }>();
  if (!file) return { players, containers };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { players, containers }; // Missing or unreadable: start fresh.
  }
  if (!isObject(data)) return { players, containers };
  if (isObject(data.players)) {
    for (const [key, value] of Object.entries(data.players)) {
      if (!PLAYER_KEY_PATTERN.test(key) || !isObject(value)) continue;
      const hotbar = readSlots(value.hotbar, HOTBAR_SLOTS);
      const backpack = readSlots(value.backpack, BACKPACK_SLOTS);
      if (!hotbar || !backpack) continue;
      const bags = newBags();
      bags.hotbar.replaceAll(hotbar);
      bags.backpack.replaceAll(backpack);
      // Older saves kept empty inventories; they'd only use up the cap.
      if (!isEmpty(bags)) players.set(key, bags);
    }
  }
  if (isObject(data.containers)) {
    for (const [id, value] of Object.entries(data.containers)) {
      if (!isObject(value)) continue;
      const slots = readSlots(value.slots, CONTAINER_SLOTS);
      if (!slots) continue;
      const inventory = new Inventory(CONTAINER_SLOTS);
      inventory.replaceAll(slots);
      containers.set(id, { slots: inventory, looted: value.looted === true });
    }
  }
  return { players, containers };
}

export function createInventoryRoom({
  file,
  allowGrants = false,
  containers: definitions = CONTAINERS.filter((c) => !c.playgroundOnly),
  positionOf,
  starterKit = STARTER_KIT,
  random = Math.random,
  maxSaved = 10_000,
  saveDelayMs = 1000,
  messagesPerSecond = 20,
  now = Date.now,
}: InventoryRoomOptions = {}) {
  const loaded = loadFile(file);
  const players = new Map<string, Player>();
  for (const [key, bags] of loaded.players)
    players.set(key, { bags, sockets: new Set(), saved: true });
  let savedCount = players.size;
  const containers = new Map<string, Container>();
  for (const definition of definitions) {
    const saved = loaded.containers.get(definition.id);
    containers.set(definition.id, {
      definition,
      slots: saved?.slots ?? new Inventory(CONTAINER_SLOTS),
      looted: saved?.looted ?? false,
    });
  }
  const connections = new Map<InventorySocket, Connection>();

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saving = Promise.resolve();

  function state({ bags }: Player, socket: InventorySocket): string {
    const connection = connections.get(socket);
    const open = connection?.open ? containers.get(connection.open) : undefined;
    const message: InventoryState = {
      type: 'blort-inventory',
      hotbar: bags.hotbar.snapshot(),
      backpack: bags.backpack.snapshot(),
      held: connection?.held ?? null,
      container: open
        ? {
            id: open.definition.id,
            kind: open.definition.kind,
            slots: open.slots.snapshot(),
          }
        : null,
    };
    return JSON.stringify(message);
  }

  function world(): string {
    const viewed = new Set(
      [...connections.values()].flatMap(({ open }) => (open ? [open] : [])),
    );
    const placements: ContainerPlacement[] = [...containers.values()].map(
      ({ definition }) => ({
        id: definition.id,
        kind: definition.kind,
        ...containerPosition(definition),
        yaw: definition.yaw,
        open: viewed.has(definition.id),
      }),
    );
    const message: InventoryWorld = {
      type: 'blort-inventory-world',
      containers: placements,
    };
    return JSON.stringify(message);
  }

  function send(socket: InventorySocket, data: string) {
    try {
      socket.send(data);
    } catch {
      // A closing socket; presence will tell us when it's gone.
    }
  }

  /** Sends every connected player the container list, e.g. a lid moved. */
  function broadcastWorld() {
    const data = world();
    for (const [socket, connection] of connections)
      if (connection.key) send(socket, data);
  }

  function holdsGun({ bags }: Player, slot: number) {
    return bags.hotbar.getSlot(slot)?.itemId === GUN_ITEM_ID;
  }

  function playerOf(socket: InventorySocket) {
    const key = connections.get(socket)?.key;
    return key ? players.get(key) : undefined;
  }

  /**
   * Holsters the gun on every connection of player whose held slot was in
   * touched, or no longer holds a gun, then sends each its state. Also sends
   * state to everyone else looking into container, so shared views stay in
   * step.
   */
  function publish(
    player: Player,
    touched: readonly SlotAddress[] = [],
    container?: string,
  ) {
    for (const socket of player.sockets) {
      const connection = connections.get(socket);
      const held = connection?.held;
      if (
        connection &&
        held !== undefined &&
        (touched.some(({ bag, index }) => bag === 'hotbar' && index === held) ||
          !holdsGun(player, held))
      )
        connection.held = undefined;
      send(socket, state(player, socket));
    }
    if (!container) return;
    for (const [socket, connection] of connections) {
      if (connection.open !== container) continue;
      const viewer = playerOf(socket);
      if (viewer && viewer !== player) send(socket, state(viewer, socket));
    }
  }

  function write() {
    if (!file) return Promise.resolve();
    const target = file;
    const saved: Record<string, { hotbar: unknown; backpack: unknown }> = {};
    for (const [key, { bags, saved: keep }] of players) {
      if (keep && !isEmpty(bags))
        saved[key] = {
          hotbar: bags.hotbar.snapshot(),
          backpack: bags.backpack.snapshot(),
        };
    }
    const savedContainers: Record<string, { slots: unknown; looted: boolean }> =
      {};
    for (const [id, { slots, looted }] of containers)
      savedContainers[id] = { slots: slots.snapshot(), looted };
    const temp = `${target}.tmp`;
    saving = saving
      .then(async () => {
        await writeFile(
          temp,
          JSON.stringify({
            version: 1,
            players: saved,
            containers: savedContainers,
          }),
        );
        await rename(temp, target);
      })
      .catch((error) => console.error('Inventory save failed', error));
    return saving;
  }

  /**
   * Gives a player a place in the save file the first time they hold
   * something, while there's room under the cap. Empty inventories never
   * take a place, so made-up keys can't use the cap up. True once saved.
   */
  function claimSave(player: Player) {
    if (player.saved) return true;
    if (isEmpty(player.bags) || savedCount >= maxSaved) return false;
    player.saved = true;
    savedCount++;
    return true;
  }

  /** Saves soon. Pass a player to skip it when they can't be saved. */
  function scheduleSave(player?: Player) {
    if (player && !claimSave(player)) return;
    if (!file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      void write();
    }, saveDelayMs);
    saveTimer.unref?.();
  }

  function playerFor(key: string): Player {
    let player = players.get(key);
    if (player) return player;
    const bags = newBags();
    for (const { bag, itemId, quantity } of starterKit)
      bags[bag].addItem(itemId, quantity);
    player = { bags, sockets: new Set(), saved: false };
    players.set(key, player);
    scheduleSave(player);
    return player;
  }

  function inReach(socket: InventorySocket, container: Container) {
    if (!positionOf) return true;
    const feet = positionOf(socket);
    return !!feet && withinReach(container.definition, feet);
  }

  /** Closes this connection's container. True if one was open. */
  function closeContainer(connection: Connection) {
    if (!connection.open) return false;
    connection.open = undefined;
    return true;
  }

  /** The first open fills a loot container from its table, once. */
  function fillLoot(container: Container) {
    const { definition } = container;
    if (definition.kind !== 'loot' || container.looted) return;
    container.looted = true;
    if (isLootTableId(definition.lootTable)) {
      const drops = rollLoot(LOOT_TABLES[definition.lootTable], random);
      for (const { itemId, quantity } of drops)
        container.slots.addItem(itemId, quantity);
    }
    scheduleSave();
  }

  function detach(socket: InventorySocket, connection: Connection) {
    const { key } = connection;
    if (!key) return;
    connection.key = undefined;
    const player = players.get(key);
    if (!player) return;
    player.sockets.delete(socket);
    // Unsaved inventories (empty, or past the save cap) only live while
    // someone is using them.
    if (!player.saved && !player.sockets.size) players.delete(key);
  }

  async function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
      await write();
    }
    await saving;
  }

  return {
    /**
     * Handles one parsed presence message. Returns true when it was an
     * inventory message (valid or not), so presence can stop handling it.
     */
    receive(socket: InventorySocket, message: unknown): boolean {
      if (!isInventoryMessage(message)) return false;
      const time = now();
      let connection = connections.get(socket);
      if (!connection) {
        connection = { windowStart: time, count: 0 };
        connections.set(socket, connection);
      }
      if (time - connection.windowStart >= 1000) {
        connection.windowStart = time;
        connection.count = 0;
      }
      // Over the limit: drop it without a reply. The browser never changes
      // its own copy before the server answers, so nothing goes out of step.
      if (++connection.count > messagesPerSecond) return true;

      const request = readRequest(message);
      if (!request) return true;

      if (request.type === 'blort-inventory-hello') {
        // One key per connection: the browser says hello once per socket, so
        // a second one is someone cycling keys to mint inventories.
        if (connection.key) return true;
        const player = playerFor(request.key);
        connection.key = request.key;
        player.sockets.add(socket);
        // The container list first, so the last word is this player's bags.
        send(socket, world());
        send(socket, state(player, socket));
        return true;
      }

      const player = connection.key ? players.get(connection.key) : undefined;
      if (!player) return true;

      if (request.type === 'blort-inventory-open') {
        const wasOpen = connection.open;
        const container = request.container
          ? containers.get(request.container)
          : undefined;
        if (container && inReach(socket, container)) {
          fillLoot(container);
          connection.open = container.definition.id;
        } else {
          connection.open = undefined;
        }
        send(socket, state(player, socket));
        if (connection.open !== wasOpen) broadcastWorld();
        return true;
      }

      if (request.type === 'blort-inventory-move') {
        const { from, to } = request;
        const open = connection.open
          ? containers.get(connection.open)
          : undefined;
        const usesContainer =
          from.bag === 'container' || to.bag === 'container';
        if (usesContainer && (!open || !inReach(socket, open))) {
          // Walked off, or never opened it: shut the lid and refuse.
          const closed = closeContainer(connection);
          send(socket, state(player, socket));
          if (closed) broadcastWorld();
          return true;
        }
        const bag = (name: Bag) =>
          name === 'container' && open
            ? open.slots
            : player.bags[name as PlayerBag];
        // Loot containers only give: nothing goes in, nothing is rearranged,
        // and taking onto a different item can't swap that item in.
        if (
          open?.definition.kind === 'loot' &&
          (to.bag === 'container' ||
            (from.bag === 'container' &&
              !canTakeInto(bag(from.bag), from.index, bag(to.bag), to.index)))
        ) {
          send(socket, state(player, socket));
          return true;
        }
        if (moveSlot(bag(from.bag), from.index, bag(to.bag), to.index)) {
          publish(
            player,
            [from, to],
            usesContainer ? open?.definition.id : undefined,
          );
          scheduleSave(player);
          if (usesContainer) scheduleSave();
        } else {
          send(socket, state(player, socket));
        }
        return true;
      }

      if (request.type === 'blort-inventory-equip') {
        const { slot } = request;
        connection.held =
          slot !== null && holdsGun(player, slot) ? slot : undefined;
        send(socket, state(player, socket));
        return true;
      }

      if (request.type === 'blort-inventory-grant') {
        if (!allowGrants) return true;
        const left = player.bags.hotbar.addItem(
          request.itemId,
          request.quantity,
        );
        player.bags.backpack.addItem(request.itemId, left);
        publish(player);
        scheduleSave(player);
      }
      return true;
    },

    /** Whether this socket's player is holding a gun right now. */
    isArmed(socket: InventorySocket): boolean {
      const connection = connections.get(socket);
      const player = connection?.key ? players.get(connection.key) : undefined;
      return (
        !!player &&
        connection?.held !== undefined &&
        holdsGun(player, connection.held)
      );
    },

    /** Forget a socket once presence has closed it. */
    disconnect(socket: InventorySocket) {
      const connection = connections.get(socket);
      if (!connection) return;
      const closed = closeContainer(connection);
      detach(socket, connection);
      connections.delete(socket);
      if (closed) broadcastWorld();
    },

    /** Write any pending changes now. */
    flush,

    /** Stop the room, saving whatever is pending. */
    close: flush,
  };
}

export type InventoryRoom = ReturnType<typeof createInventoryRoom>;

/**
 * The room as server/presence.ts creates it. Saves beside the plots file
 * (or to BLORT_INVENTORY_FILE) when presence has one, which the standalone
 * server always does. Vite's dev servers have none, so they keep inventories
 * in memory. Grants and playground containers follow presence's playground
 * (practice) flag.
 */
export function inventoryRoomForPresence(
  plotsFile?: string,
  practice = false,
  positionOf?: (socket: InventorySocket) => Feet | undefined,
) {
  const file =
    process.env.BLORT_INVENTORY_FILE ||
    (plotsFile
      ? join(dirname(plotsFile), 'blort-inventories.json')
      : undefined);
  return createInventoryRoom({
    file,
    allowGrants: practice,
    containers: CONTAINERS.filter((c) => practice || !c.playgroundOnly),
    positionOf,
  });
}
