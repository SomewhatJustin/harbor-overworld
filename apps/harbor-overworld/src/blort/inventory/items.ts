// Every item in the game, in one place. The TypeScript stand-in for Unreal
// item data assets: add an entry to ITEM_LIST to add an item.

export type ItemDefinition = {
  /** Stable key stored in slots. Never shown to players. */
  id: string;
  name: string;
  description: string;
  /** An image URL under /blort/items/, or a single glyph as a placeholder. */
  icon: string;
  /** Most of this item one slot can hold. 1 means it doesn't stack. */
  maxStack: number;
};

export const ITEM_LIST: readonly ItemDefinition[] = [
  {
    id: 'driftwood',
    name: 'Driftwood',
    description: 'Bleached by the tide.',
    icon: '🪵',
    maxStack: 20,
  },
  {
    id: 'rope',
    name: 'Rope',
    description: 'Salt-stiff hemp.',
    icon: '🪢',
    maxStack: 10,
  },
  {
    id: 'lantern',
    name: 'Lantern',
    description: 'Still smells of oil.',
    icon: '🏮',
    maxStack: 1,
  },
  {
    id: 'pistol',
    name: 'Pistol',
    description: 'Press its hotbar key to draw or holster it.',
    icon: '🔫',
    maxStack: 1,
  },
];

/** Items that put the gun in the player's hand while held. */
export const GUN_ITEM_ID = 'pistol';

export const ITEMS: ReadonlyMap<string, ItemDefinition> = new Map(
  ITEM_LIST.map((item) => [item.id, item]),
);

export function getItem(id: string): ItemDefinition {
  const item = ITEMS.get(id);
  if (!item) throw new Error(`Unknown item ${id}`);
  return item;
}
