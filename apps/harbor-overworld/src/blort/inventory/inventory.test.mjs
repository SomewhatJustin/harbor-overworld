import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Inventory, moveSlot } from './inventory.ts';
import { getItem, ITEM_LIST } from './items.ts';

test('item ids are unique and stack sizes are positive', () => {
  const ids = ITEM_LIST.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of ITEM_LIST) {
    assert.ok(Number.isInteger(item.maxStack) && item.maxStack >= 1, item.id);
  }
  assert.throws(() => getItem('missing'));
});

test('addItem tops up partial stacks before filling empty slots', () => {
  const bag = new Inventory(4);
  assert.equal(bag.addItem('rope', 4), 0);
  assert.equal(bag.addItem('lantern', 1), 0);
  assert.equal(bag.addItem('rope', 8), 0);
  assert.deepEqual(bag.getSlot(0), { itemId: 'rope', quantity: 10 });
  assert.deepEqual(bag.getSlot(1), { itemId: 'lantern', quantity: 1 });
  assert.deepEqual(bag.getSlot(2), { itemId: 'rope', quantity: 2 });
  assert.equal(bag.getItemCount('rope'), 12);
});

test('addItem returns what does not fit', () => {
  const bag = new Inventory(2);
  assert.equal(bag.addItem('lantern', 3), 1);
  assert.equal(bag.getItemCount('lantern'), 2);
  assert.throws(() => bag.addItem('missing', 1));
});

test('removeItem is all or nothing and clears empty slots', () => {
  const bag = new Inventory(1);
  bag.addItem('rope', 3);
  assert.equal(bag.removeItem(0, 4), false);
  assert.equal(bag.removeItem(0, 2), true);
  assert.deepEqual(bag.getSlot(0), { itemId: 'rope', quantity: 1 });
  assert.equal(bag.removeItem(0, 1), true);
  assert.equal(bag.getSlot(0), null);
  assert.equal(bag.removeItem(5, 1), false);
});

test('moveSlot moves into an empty slot', () => {
  const bag = new Inventory(3);
  bag.addItem('rope', 3);
  assert.equal(moveSlot(bag, 0, bag, 2), true);
  assert.equal(bag.getSlot(0), null);
  assert.deepEqual(bag.getSlot(2), { itemId: 'rope', quantity: 3 });
});

test('moveSlot merges up to the max stack and leaves the rest', () => {
  const bag = new Inventory(2);
  bag.addItem('rope', 10);
  bag.addItem('rope', 7);
  assert.equal(moveSlot(bag, 0, bag, 1), true);
  assert.deepEqual(bag.getSlot(1), { itemId: 'rope', quantity: 10 });
  assert.deepEqual(bag.getSlot(0), { itemId: 'rope', quantity: 7 });
  assert.equal(moveSlot(bag, 0, bag, 1), false, 'target is already full');
});

test('moveSlot swaps different items across inventories', () => {
  const hotbar = new Inventory(6);
  const backpack = new Inventory(24);
  hotbar.addItem('lantern', 1);
  backpack.addItem('driftwood', 5);
  const changed = [];
  hotbar.onSlotChanged((index) => changed.push(['hotbar', index]));
  backpack.onSlotChanged((index) => changed.push(['backpack', index]));
  assert.equal(moveSlot(backpack, 0, hotbar, 0), true);
  assert.deepEqual(hotbar.getSlot(0), { itemId: 'driftwood', quantity: 5 });
  assert.deepEqual(backpack.getSlot(0), { itemId: 'lantern', quantity: 1 });
  assert.deepEqual(changed, [
    ['hotbar', 0],
    ['backpack', 0],
  ]);
});

test('moveSlot rejects bad indexes, empty sources and self moves', () => {
  const bag = new Inventory(2);
  bag.addItem('rope', 1);
  assert.equal(moveSlot(bag, 0, bag, 0), false);
  assert.equal(moveSlot(bag, 1, bag, 0), false);
  assert.equal(moveSlot(bag, 0, bag, 9), false);
  assert.equal(moveSlot(bag, -1, bag, 1), false);
  assert.deepEqual(bag.getSlot(0), { itemId: 'rope', quantity: 1 });
});
