// Entry point for Blort's additions. Loaded by its own <script> tag in
// index.html after the game's main.ts, so the game doesn't import anything
// from here; it only reads the hooks in src/world/bridge.ts. The inventory
// itself lives on the server; these Inventory objects only mirror what it
// sends.

import { setArmed } from '../world/bridge.ts';
import { mountInventoryHud } from './inventory/hud.ts';
import { Inventory } from './inventory/inventory.ts';
import { GUN_ITEM_ID } from './inventory/items.ts';
import { inventoryLink } from './inventory/link.ts';
import {
  BACKPACK_COLUMNS,
  BACKPACK_SLOTS,
  HOTBAR_SLOTS,
} from './inventory/protocol.ts';
import { mountInteraction } from './interact.ts';
import { mountChests } from './loot/chests.ts';
import { CONTAINER_SLOTS } from './loot/containers.ts';

const game = document.getElementById('overworld');
const world = document.getElementById('world');

if (game && world instanceof HTMLCanvasElement) {
  const hotbar = new Inventory(HOTBAR_SLOTS);
  const backpack = new Inventory(BACKPACK_SLOTS);
  const container = new Inventory(CONTAINER_SLOTS);

  // The chest this tab has open, as the server last said, and one we've
  // asked to open but haven't heard back about.
  let openId: string | null = null;
  let pendingOpen: string | null = null;
  /** The hotbar slot whose gun is drawn, as the server last said. */
  let held: number | null = null;

  const hud = mountInventoryHud({
    game,
    world,
    hotbar,
    backpack,
    container,
    backpackColumns: BACKPACK_COLUMNS,
    onMove: (from, to) => inventoryLink.move(from, to),
    // The gun's key draws it; pressing it again, or any other slot's key,
    // holsters it. The server decides and replies with what's held.
    onHotbarKey: (index) => {
      if (!inventoryLink.online) return;
      if (held === index) inventoryLink.equip(null);
      else if (hotbar.getSlot(index)?.itemId === GUN_ITEM_ID)
        inventoryLink.equip(index);
      else if (held !== null) inventoryLink.equip(null);
    },
    onCloseContainer: () => {
      openId = null;
      pendingOpen = null;
      inventoryLink.open(null);
    },
  });

  const chests = mountChests({
    openHere: () => (hud.containerKind ? openId : null),
    onOpen: (id) => {
      pendingOpen = id;
      inventoryLink.open(id);
    },
    onLeave: () => hud.setOpen(false),
  });
  mountInteraction({
    ready: () => inventoryLink.online && !hud.blockedByGame() && !hud.open,
    setPrompt: hud.setPrompt,
  });

  function setHeld(next: number | null) {
    held = next;
    hud.setHeld(held);
    setArmed(held !== null);
  }

  inventoryLink.onState((state) => {
    hotbar.replaceAll(state.hotbar);
    backpack.replaceAll(state.backpack);
    setHeld(state.held);
    const open = state.container;
    if (open) {
      container.replaceAll(open.slots);
      if (open.id === pendingOpen) {
        // The server let us in: show the chest above the backpack.
        pendingOpen = null;
        openId = open.id;
        hud.setContainer(open.kind);
        hud.setOpen(true);
      } else if (open.id !== openId || !hud.containerKind) {
        // Open on the server but not here (closed meanwhile): tidy up.
        inventoryLink.open(null);
      }
    } else {
      pendingOpen = null;
      if (hud.containerKind) {
        // The server shut it, e.g. we were out of reach.
        openId = null;
        hud.setContainer(null);
        hud.setOpen(false);
      }
    }
  });
  inventoryLink.onWorld(chests.setPlacements);
  inventoryLink.onOnline((online) => {
    hud.setOnline(online);
    if (!online) {
      setHeld(null);
      if (hud.containerKind) hud.setOpen(false);
    }
  });
  hud.setOnline(inventoryLink.online);

  // From the browser console while developing. grant only works in the
  // playground, where the server allows it: blortInventory.grant('rope', 5)
  if (import.meta.env.DEV)
    Object.assign(window, {
      blortInventory: {
        hotbar,
        backpack,
        container,
        hud,
        grant: inventoryLink.grant,
      },
    });
}
