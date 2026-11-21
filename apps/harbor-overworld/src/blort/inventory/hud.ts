// The hotbar (always visible in the world) and the backpack panel (Tab),
// which also shows an open chest above the backpack.
// Kept apart from the game's own HUD: it reads game state from the DOM
// (#overworld.entered, open dialogs, pointer lock) instead of importing it.

import { canTakeInto, type Inventory } from './inventory.ts';
import { getItem } from './items.ts';
import type { ContainerKind } from '../loot/containers.ts';
import type { Bag, SlotAddress } from './protocol.ts';
import './inventory.css';

type HudOptions = {
  game: HTMLElement;
  world: HTMLCanvasElement;
  hotbar: Inventory;
  backpack: Inventory;
  /** Mirrors whichever chest is open. Shown only while one is. */
  container: Inventory;
  backpackColumns: number;
  /** Asks for a stack to move. The inventories update when the server replies. */
  onMove: (from: SlotAddress, to: SlotAddress) => void;
  /** A hotbar number key was pressed, after its slot is selected. */
  onHotbarKey?: (index: number) => void;
  /** The panel closed while a chest was showing. */
  onCloseContainer?: () => void;
};

type SlotRef = { inventory: Inventory; bag: Bag; index: number };

/** Keys the game reads that should do nothing while the backpack is open. */
const BLOCKED_WHILE_OPEN = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'Enter',
  'NumpadEnter',
  'KeyE',
  'KeyF',
  'KeyG',
  'KeyK',
  'KeyL',
  'KeyR',
  'KeyT',
]);

export function mountInventoryHud({
  game,
  world,
  hotbar,
  backpack,
  container,
  backpackColumns,
  onMove,
  onHotbarKey,
  onCloseContainer,
}: HudOptions) {
  const root = document.createElement('div');
  root.className = 'blort-inventory';

  const backdrop = document.createElement('div');
  backdrop.className = 'blort-backdrop';
  backdrop.hidden = true;

  const panel = document.createElement('section');
  panel.className = 'blort-backpack plate';
  panel.setAttribute('aria-label', 'Backpack');
  panel.hidden = true;
  const heading = document.createElement('header');
  heading.className = 'blort-heading';
  heading.innerHTML =
    '<span>BACKPACK</span><span class="blort-hint"><kbd>Tab</kbd> Close</span>';
  const grid = document.createElement('div');
  grid.className = 'blort-grid';
  grid.style.setProperty('--blort-columns', String(backpackColumns));

  const chest = document.createElement('div');
  chest.className = 'blort-chest';
  chest.hidden = true;
  const chestHeading = document.createElement('header');
  chestHeading.className = 'blort-heading';
  const chestTitle = document.createElement('span');
  const chestHint = document.createElement('span');
  chestHint.className = 'blort-hint';
  chestHeading.append(chestTitle, chestHint);
  const chestGrid = document.createElement('div');
  chestGrid.className = 'blort-grid';
  chestGrid.style.setProperty('--blort-columns', String(backpackColumns));
  chest.append(chestHeading, chestGrid);

  panel.append(chest, heading, grid);

  const bar = document.createElement('div');
  bar.className = 'blort-hotbar plate';
  bar.setAttribute('aria-label', 'Hotbar');

  const prompt = document.createElement('p');
  prompt.className = 'blort-prompt plate';
  prompt.setAttribute('role', 'status');
  prompt.hidden = true;

  const offlineLabel = document.createElement('p');
  offlineLabel.className = 'blort-offline';
  offlineLabel.setAttribute('role', 'status');
  offlineLabel.textContent = 'Inventory offline';

  const ghost = document.createElement('div');
  ghost.className = 'blort-ghost';
  ghost.hidden = true;

  root.append(panel, prompt, offlineLabel, bar);

  /** "Press E to interact", above the hotbar. */
  const promptKey = document.createElement('kbd');
  promptKey.textContent = 'E';
  prompt.replaceChildren('Press', promptKey, 'to interact');
  function setPrompt(visible: boolean) {
    prompt.hidden = !visible;
  }
  game.append(backdrop, root, ghost);

  const slotElements = new Map<Inventory, HTMLButtonElement[]>();
  const slotRefs = new WeakMap<Element, SlotRef>();

  function buildSlots(
    inventory: Inventory,
    bag: Bag,
    parent: HTMLElement,
    numbered: boolean,
  ) {
    const elements = Array.from({ length: inventory.size }, (_, index) => {
      const slot = document.createElement('button');
      slot.type = 'button';
      slot.className = 'blort-slot';
      slot.tabIndex = -1;
      if (numbered) slot.dataset.key = String(index + 1);
      slotRefs.set(slot, { inventory, bag, index });
      parent.append(slot);
      return slot;
    });
    slotElements.set(inventory, elements);
    inventory.onSlotChanged((index) => paint(inventory, index));
    for (let i = 0; i < inventory.size; i++) paint(inventory, i);
  }

  function iconNode(icon: string) {
    if (icon.includes('/')) {
      const image = document.createElement('img');
      image.src = icon;
      image.alt = '';
      image.draggable = false;
      return image;
    }
    const glyph = document.createElement('span');
    glyph.textContent = icon;
    return glyph;
  }

  function paint(inventory: Inventory, index: number) {
    const element = slotElements.get(inventory)?.[index];
    if (!element) return;
    const slot = inventory.getSlot(index);
    element.replaceChildren();
    element.classList.toggle('filled', !!slot);
    const position = `Slot ${index + 1}`;
    if (!slot) {
      element.title = '';
      element.setAttribute('aria-label', `${position}: empty`);
      return;
    }
    const item = getItem(slot.itemId);
    const icon = iconNode(item.icon);
    icon.className = 'blort-icon';
    element.append(icon);
    if (slot.quantity > 1) {
      const count = document.createElement('span');
      count.className = 'blort-count';
      count.textContent = String(slot.quantity);
      element.append(count);
    }
    element.title = `${item.name}\n${item.description}`;
    element.setAttribute(
      'aria-label',
      `${position}: ${item.name}${slot.quantity > 1 ? ` ×${slot.quantity}` : ''}`,
    );
  }

  buildSlots(container, 'container', chestGrid, false);
  buildSlots(backpack, 'backpack', grid, false);
  buildSlots(hotbar, 'hotbar', bar, true);

  // Offline until the server's state arrives. Slots keep their last known
  // contents, dimmed, and can't be dragged.
  let online = false;
  root.classList.add('offline');
  function setOnline(next: boolean) {
    online = next;
    root.classList.toggle('offline', !online);
    if (!online) cancelDrag();
  }

  // The hotbar slot whose gun is drawn, outlined until it's holstered.
  let held: number | null = null;
  function setHeld(index: number | null) {
    const elements = slotElements.get(hotbar) ?? [];
    if (held !== null) elements[held]?.classList.remove('held');
    held = index;
    if (held !== null) elements[held]?.classList.add('held');
  }

  // Hotbar selection (1–6). Keys also go to onHotbarKey.
  let selected = 0;
  function select(index: number) {
    const elements = slotElements.get(hotbar) ?? [];
    elements[selected]?.classList.remove('selected');
    selected = index;
    elements[selected]?.classList.add('selected');
  }
  select(0);

  // The open chest, if any. Loot chests only give, so they take no drops.
  let containerKind: ContainerKind | null = null;
  function setContainer(kind: ContainerKind | null) {
    containerKind = kind;
    chest.hidden = !kind;
    chest.classList.toggle('take-only', kind === 'loot');
    chestTitle.textContent = kind === 'loot' ? 'LOOT CHEST' : 'CHEST';
    chestHint.innerHTML =
      kind === 'loot' ? 'Take only · <kbd>E</kbd> Close' : '<kbd>E</kbd> Close';
    panel.setAttribute('aria-label', kind ? 'Chest and backpack' : 'Backpack');
  }

  // Backpack panel
  let open = false;
  let relock = false;

  function blockedByGame() {
    return (
      !game.classList.contains('entered') ||
      !!game.querySelector('dialog[open]')
    );
  }

  function setOpen(next: boolean) {
    if (next === open) return;
    open = next;
    panel.hidden = !open;
    backdrop.hidden = !open;
    root.classList.toggle('open', open);
    if (open) {
      relock = document.pointerLockElement === world;
      if (relock) document.exitPointerLock();
    } else {
      cancelDrag();
      if (containerKind) {
        setContainer(null);
        onCloseContainer?.();
      }
      if (
        document.activeElement instanceof HTMLElement &&
        root.contains(document.activeElement)
      )
        document.activeElement.blur();
      if (relock && !blockedByGame()) {
        try {
          void world.requestPointerLock?.()?.catch(() => undefined);
        } catch {
          // The player can click the world to look around again.
        }
      }
      relock = false;
    }
  }

  // Capture phase so this runs before the game's own keydown handler.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable], dialog')
      )
        return;

      if (event.code === 'Tab') {
        if (blockedByGame()) return;
        event.preventDefault();
        if (!event.repeat) setOpen(!open);
        return;
      }
      if (open && containerKind && event.code === 'KeyE') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) setOpen(false);
        return;
      }
      if (open && event.code === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit && !blockedByGame()) {
        const index = Number(digit[1]) - 1;
        if (index < hotbar.size) {
          event.preventDefault();
          select(index);
          if (!event.repeat) onHotbarKey?.(index);
          return;
        }
      }
      if (open && BLOCKED_WHILE_OPEN.has(event.code)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    { capture: true },
  );

  // A dialog the game opens (chat, identity) takes over from the backpack.
  new MutationObserver(() => {
    if (open && game.querySelector('dialog[open]')) {
      relock = false;
      setOpen(false);
    }
  }).observe(game, { subtree: true, attributeFilter: ['open'] });

  // Drag and drop between slots
  let drag: (SlotRef & { pointerId: number }) | undefined;

  function moveGhost(event: PointerEvent) {
    ghost.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
  }

  function cancelDrag() {
    if (!drag) return;
    slotElements
      .get(drag.inventory)
      ?.[drag.index]?.classList.remove('dragging');
    drag = undefined;
    ghost.hidden = true;
    ghost.replaceChildren();
  }

  root.addEventListener('pointerdown', (event) => {
    if (!open || !online || event.button !== 0 || drag) return;
    const element = (event.target as Element).closest('.blort-slot');
    const ref = element && slotRefs.get(element);
    if (!ref) return;
    const slot = ref.inventory.getSlot(ref.index);
    if (!slot) return;
    event.preventDefault();
    drag = { ...ref, pointerId: event.pointerId };
    element.classList.add('dragging');
    const icon = iconNode(getItem(slot.itemId).icon);
    icon.className = 'blort-icon';
    ghost.replaceChildren(icon);
    ghost.hidden = false;
    moveGhost(event);
  });

  window.addEventListener('pointermove', (event) => {
    if (drag && event.pointerId === drag.pointerId) moveGhost(event);
  });

  window.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { inventory, bag, index } = drag;
    cancelDrag();
    const element = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest('.blort-slot');
    const target = element && slotRefs.get(element);
    if (!target || (target.bag === bag && target.index === index)) return;
    // Loot chests only give (the server enforces this too).
    if (
      containerKind === 'loot' &&
      (target.bag === 'container' ||
        (bag === 'container' &&
          !canTakeInto(inventory, index, target.inventory, target.index)))
    )
      return;
    onMove({ bag, index }, { bag: target.bag, index: target.index });
  });

  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);

  return {
    get open() {
      return open;
    },
    setOpen,
    setContainer,
    setPrompt,
    blockedByGame,
    get containerKind() {
      return containerKind;
    },
    select,
    setHeld,
    setOnline,
  };
}
