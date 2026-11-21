import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem, ITEM_LIST } from '../inventory/items.ts';
import { LOOT_TABLES, rollLoot } from './tables.ts';

/** A repeatable stand-in for Math.random. */
function seeded(seed) {
  // mulberry32
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

test('the basic table offers every item there is', () => {
  const ids = [
    ...LOOT_TABLES.basic.guaranteed,
    ...LOOT_TABLES.basic.entries,
  ].map(({ itemId }) => itemId);
  assert.deepEqual(
    [...new Set(ids)].sort(),
    ITEM_LIST.map(({ id }) => id).sort(),
  );
});

test('basic always gives one pistol and 2–3 different items in all', () => {
  const counts = new Set();
  const seen = new Set();
  for (let seed = 1; seed <= 500; seed++) {
    const drops = rollLoot(LOOT_TABLES.basic, seeded(seed));
    counts.add(drops.length);
    assert.ok(drops.length >= 2 && drops.length <= 3, `seed ${seed}`);
    const ids = drops.map(({ itemId }) => itemId);
    assert.equal(new Set(ids).size, ids.length, 'no item twice');
    assert.equal(ids.filter((id) => id === 'pistol').length, 1, `seed ${seed}`);
    for (const { itemId, quantity } of drops) {
      seen.add(itemId);
      assert.ok(Number.isInteger(quantity) && quantity >= 1);
      assert.ok(quantity <= getItem(itemId).maxStack, itemId);
    }
  }
  assert.deepEqual([...counts].sort(), [2, 3]);
  assert.equal(seen.size, ITEM_LIST.length, 'every item turns up sometimes');
});

test('guaranteed entries drop first and stay out of the rolls', () => {
  const table = {
    guaranteed: [{ itemId: 'rope', min: 2, max: 2 }],
    rolls: { min: 2, max: 2 },
    entries: [{ itemId: 'rope' }, { itemId: 'lantern' }],
  };
  assert.deepEqual(rollLoot(table, seeded(3)), [
    { itemId: 'rope', quantity: 2 },
    { itemId: 'lantern', quantity: 1 },
  ]);
});

test('the same random source rolls the same loot', () => {
  assert.deepEqual(
    rollLoot(LOOT_TABLES.basic, seeded(42)),
    rollLoot(LOOT_TABLES.basic, seeded(42)),
  );
});

test('weights steer picks and zero weight never drops', () => {
  const table = {
    rolls: { min: 1, max: 1 },
    entries: [
      { itemId: 'rope', weight: 0 },
      { itemId: 'lantern', weight: 1 },
    ],
  };
  for (let seed = 1; seed <= 50; seed++)
    assert.deepEqual(rollLoot(table, seeded(seed)), [
      { itemId: 'lantern', quantity: 1 },
    ]);
});

test('rolls never ask for more items than the table has', () => {
  const table = {
    rolls: { min: 5, max: 5 },
    entries: [{ itemId: 'rope', min: 2, max: 2 }],
  };
  assert.deepEqual(rollLoot(table, seeded(1)), [
    { itemId: 'rope', quantity: 2 },
  ]);
});
