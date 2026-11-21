// Loot tables: what a loot chest fills itself with the first time it's
// opened. Data plus one roll function, shared by the server and tests.

import { GUN_ITEM_ID, getItem, ITEM_LIST } from '../inventory/items.ts';

export type LootEntry = {
  itemId: string;
  /** Relative chance to be picked. Defaults to 1. */
  weight?: number;
  /** Stack size range, inclusive. Clamped to the item's max stack. */
  min?: number;
  max?: number;
};

export type LootTable = {
  /** Always dropped, before the rolls. */
  guaranteed?: readonly LootEntry[];
  /** How many more different items to pick from entries, inclusive. */
  rolls: { min: number; max: number };
  /** The pool for rolls. Guaranteed items are left out of it. */
  entries: readonly LootEntry[];
};

export type LootDrop = { itemId: string; quantity: number };

/** Stack sizes for items that shouldn't use the default of 1–3. */
const BASIC_QUANTITIES: Record<string, { min: number; max: number }> = {
  driftwood: { min: 2, max: 6 },
};

const basicEntry = (itemId: string): LootEntry => ({
  itemId,
  ...(BASIC_QUANTITIES[itemId] ?? { min: 1, max: 3 }),
});

export const LOOT_TABLES = {
  /**
   * A gun every time, so players can find one and start fighting, plus 1–2
   * other items, each equally likely, from every other item there is.
   */
  basic: {
    guaranteed: [basicEntry(GUN_ITEM_ID)],
    rolls: { min: 1, max: 2 },
    entries: ITEM_LIST.map(({ id }) => basicEntry(id)),
  },
} satisfies Record<string, LootTable>;

export type LootTableId = keyof typeof LOOT_TABLES;

export function isLootTableId(value: unknown): value is LootTableId {
  return typeof value === 'string' && Object.hasOwn(LOOT_TABLES, value);
}

/** A whole number from min to max inclusive. */
function between(min: number, max: number, random: () => number) {
  return min + Math.floor(random() * (max - min + 1));
}

function drop(entry: LootEntry, random: () => number): LootDrop {
  const { maxStack } = getItem(entry.itemId);
  const max = Math.max(1, Math.min(maxStack, entry.max ?? 1));
  const min = Math.max(1, Math.min(max, entry.min ?? 1));
  return { itemId: entry.itemId, quantity: between(min, max, random) };
}

/**
 * Drops every guaranteed entry, then picks rolls more entries, weighted,
 * never the same item twice, with a stack size for each. Pass random to make
 * it repeatable.
 */
export function rollLoot(
  table: LootTable,
  random: () => number = Math.random,
): LootDrop[] {
  const guaranteed = table.guaranteed ?? [];
  const drops = guaranteed.map((entry) => drop(entry, random));
  const pool = table.entries.filter(
    (entry) =>
      (entry.weight ?? 1) > 0 &&
      !guaranteed.some(({ itemId }) => itemId === entry.itemId),
  );
  const count = Math.min(
    pool.length,
    between(table.rolls.min, table.rolls.max, random),
  );
  for (let i = 0; i < count; i++) {
    const total = pool.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
    let pick = random() * total;
    let index = 0;
    while (index < pool.length - 1 && pick >= (pool[index].weight ?? 1)) {
      pick -= pool[index].weight ?? 1;
      index++;
    }
    const [entry] = pool.splice(index, 1);
    drops.push(drop(entry, random));
  }
  return drops;
}
