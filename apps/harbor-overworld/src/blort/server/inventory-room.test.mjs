import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ground } from '../../world/terrain.ts';
import {
  createInventoryRoom as createRoom,
  STARTER_KIT,
} from './inventory-room.ts';

/** The old starter kit, so tests have a pistol, lantern and rope to move. */
const TEST_KIT = [
  { bag: 'hotbar', itemId: 'pistol', quantity: 1 },
  { bag: 'hotbar', itemId: 'lantern', quantity: 1 },
  { bag: 'hotbar', itemId: 'rope', quantity: 3 },
  { bag: 'backpack', itemId: 'driftwood', quantity: 26 },
  { bag: 'backpack', itemId: 'rope', quantity: 6 },
];

const createInventoryRoom = (options = {}) =>
  createRoom({ starterKit: TEST_KIT, ...options });

const KEY_A = 'a'.repeat(32);
const KEY_B = 'b'.repeat(32);

function socket() {
  const sent = [];
  return {
    sent,
    send(data) {
      sent.push(JSON.parse(data));
    },
    get last() {
      return sent.at(-1);
    },
  };
}

const hello = (key) => ({ type: 'blort-inventory-hello', key });
const move = (fromBag, fromIndex, toBag, toIndex) => ({
  type: 'blort-inventory-move',
  from: { bag: fromBag, index: fromIndex },
  to: { bag: toBag, index: toIndex },
});
const grant = (itemId, quantity) => ({
  type: 'blort-inventory-grant',
  itemId,
  quantity,
});

function count(state, itemId) {
  return [...state.hotbar, ...state.backpack]
    .filter((slot) => slot?.itemId === itemId)
    .reduce((sum, slot) => sum + slot.quantity, 0);
}

test('ignores messages that are not for the inventory', () => {
  const room = createInventoryRoom();
  const ws = socket();
  assert.equal(room.receive(ws, { x: 1, y: 2, z: 3, yaw: 0 }), false);
  assert.equal(room.receive(ws, { type: 'shoot' }), false);
  assert.equal(room.receive(ws, null), false);
  assert.equal(ws.sent.length, 0);
});

test('new players start with nothing', () => {
  assert.deepEqual(STARTER_KIT, []);
  const room = createRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  assert.deepEqual(ws.last.hotbar, Array(6).fill(null));
  assert.deepEqual(ws.last.backpack, Array(24).fill(null));
});

test('hello gives a new key the starter kit', () => {
  const room = createInventoryRoom();
  const ws = socket();
  assert.equal(room.receive(ws, hello(KEY_A)), true);
  assert.equal(ws.last.type, 'blort-inventory');
  assert.equal(ws.last.hotbar.length, 6);
  assert.equal(ws.last.backpack.length, 24);
  for (const { itemId } of TEST_KIT) {
    const expected = TEST_KIT.filter((k) => k.itemId === itemId).reduce(
      (sum, k) => sum + k.quantity,
      0,
    );
    assert.equal(count(ws.last, itemId), expected, itemId);
  }
});

test('a bad key is claimed as an inventory message but refused', () => {
  const room = createInventoryRoom();
  const ws = socket();
  assert.equal(room.receive(ws, hello('NOT-A-KEY')), true);
  assert.equal(room.receive(ws, move('hotbar', 0, 'hotbar', 5)), true);
  assert.equal(ws.sent.length, 0);
});

test('moves before hello change nothing', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, move('hotbar', 0, 'hotbar', 5));
  assert.equal(ws.sent.length, 0);
  room.receive(ws, hello(KEY_A));
  assert.equal(ws.last.hotbar[0].itemId, 'pistol');
  assert.equal(ws.last.hotbar[5], null);
});

test('a move is applied and sent to every socket on the key', () => {
  const room = createInventoryRoom();
  const tab1 = socket();
  const tab2 = socket();
  room.receive(tab1, hello(KEY_A));
  room.receive(tab2, hello(KEY_A));
  room.receive(tab1, move('hotbar', 0, 'backpack', 23));
  for (const tab of [tab1, tab2]) {
    assert.equal(tab.last.hotbar[0], null);
    assert.deepEqual(tab.last.backpack[23], { itemId: 'pistol', quantity: 1 });
  }
});

test('invalid moves leave the slots alone', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  const before = ws.last;
  room.receive(ws, move('hotbar', 0, 'hotbar', 6)); // out of range
  room.receive(ws, move('pocket', 0, 'hotbar', 1)); // unknown bag
  room.receive(ws, move('hotbar', 5, 'hotbar', 1)); // empty source
  assert.deepEqual(ws.last.hotbar, before.hotbar);
  assert.deepEqual(ws.last.backpack, before.backpack);
});

test('keys cannot see or change each other', () => {
  const room = createInventoryRoom();
  const a = socket();
  const b = socket();
  room.receive(a, hello(KEY_A));
  room.receive(b, hello(KEY_B));
  const bSent = b.sent.length;
  room.receive(a, move('hotbar', 0, 'hotbar', 5));
  assert.equal(b.sent.length, bSent);
  assert.equal(b.last.hotbar[0].itemId, 'pistol');
});

test('grant only works when allowed', () => {
  const closed = createInventoryRoom();
  const ws = socket();
  closed.receive(ws, hello(KEY_A));
  const sent = ws.sent.length;
  closed.receive(ws, grant('rope', 5));
  assert.equal(ws.sent.length, sent);

  const playground = createInventoryRoom({ allowGrants: true });
  const dev = socket();
  playground.receive(dev, hello(KEY_A));
  const before = count(dev.last, 'rope');
  playground.receive(dev, grant('rope', 5));
  assert.equal(count(dev.last, 'rope'), before + 5);
  playground.receive(dev, grant('gold', 5));
  playground.receive(dev, grant('rope', 100000));
  assert.equal(count(dev.last, 'rope'), before + 5);
});

test('messages past the rate limit are dropped', () => {
  let time = 0;
  const room = createInventoryRoom({ messagesPerSecond: 3, now: () => time });
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, move('hotbar', 0, 'hotbar', 5));
  room.receive(ws, move('hotbar', 5, 'hotbar', 0));
  room.receive(ws, move('hotbar', 0, 'hotbar', 4)); // 4th this second
  assert.equal(ws.last.hotbar[0].itemId, 'pistol');
  time = 1000;
  room.receive(ws, move('hotbar', 0, 'hotbar', 4));
  assert.equal(ws.last.hotbar[4].itemId, 'pistol');
});

test('inventories survive a restart through the save file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blort-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventories.json');

  const first = createInventoryRoom({ file, saveDelayMs: 10 });
  const ws = socket();
  first.receive(ws, hello(KEY_A));
  first.receive(ws, move('hotbar', 0, 'backpack', 20));
  await first.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.ok(saved.players[KEY_A]);

  const second = createInventoryRoom({ file });
  const again = socket();
  second.receive(again, hello(KEY_A));
  assert.equal(again.last.hotbar[0], null);
  assert.deepEqual(again.last.backpack[20], { itemId: 'pistol', quantity: 1 });
});

test('keys past the save cap work but are not saved', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blort-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventories.json');
  const room = createInventoryRoom({ file, maxSaved: 1 });
  const a = socket();
  const b = socket();
  room.receive(a, hello(KEY_A));
  room.receive(b, hello(KEY_B));
  assert.equal(b.last.type, 'blort-inventory');
  await room.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.players), [KEY_A]);
});

test('a second hello on the same connection is ignored', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  const sent = ws.sent.length;
  assert.equal(room.receive(ws, hello(KEY_B)), true);
  assert.equal(ws.sent.length, sent, 'no reply');
  // Still KEY_A's bags: moving the pistol works on them.
  room.receive(ws, move('hotbar', 0, 'backpack', 20));
  assert.equal(ws.last.backpack[20].itemId, 'pistol');
});

test('a corrupt save file starts fresh instead of crashing', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blort-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventories.json');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(file, '{ not json');
  const room = createInventoryRoom({ file });
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  assert.equal(ws.last.hotbar[0].itemId, 'pistol');
});

const equip = (slot) => ({ type: 'blort-inventory-equip', slot });

test('the starter pistol is in hotbar slot 1 and starts holstered', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  assert.equal(ws.last.hotbar[0].itemId, 'pistol');
  assert.equal(ws.last.held, null);
  assert.equal(room.isArmed(ws), false);
});

test('equip draws the gun and null holsters it', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, equip(0));
  assert.equal(ws.last.held, 0);
  assert.equal(room.isArmed(ws), true);
  room.receive(ws, equip(null));
  assert.equal(ws.last.held, null);
  assert.equal(room.isArmed(ws), false);
});

test('equip refuses slots without a gun and bad slots', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, equip(1)); // rope
  assert.equal(ws.last.held, null);
  room.receive(ws, equip(5)); // empty
  assert.equal(ws.last.held, null);
  const sent = ws.sent.length;
  room.receive(ws, equip(6)); // out of range
  room.receive(ws, equip('0'));
  assert.equal(ws.sent.length, sent);
  assert.equal(room.isArmed(ws), false);
});

test('moving the held gun anywhere holsters it', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, equip(0));
  room.receive(ws, move('hotbar', 0, 'hotbar', 5));
  assert.equal(ws.last.held, null);
  assert.equal(room.isArmed(ws), false);

  room.receive(ws, equip(5));
  room.receive(ws, move('hotbar', 5, 'backpack', 23));
  assert.equal(ws.last.held, null);
  assert.equal(room.isArmed(ws), false);
});

test('moving something onto the held slot holsters it', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, equip(0));
  room.receive(ws, move('hotbar', 1, 'hotbar', 0)); // rope swaps in
  assert.equal(ws.last.hotbar[1].itemId, 'pistol');
  assert.equal(ws.last.held, null);
  assert.equal(room.isArmed(ws), false);
});

test('moves that miss the held slot keep the gun drawn', () => {
  const room = createInventoryRoom();
  const ws = socket();
  room.receive(ws, hello(KEY_A));
  room.receive(ws, equip(0));
  room.receive(ws, move('hotbar', 1, 'hotbar', 4));
  assert.equal(ws.last.held, 0);
  assert.equal(room.isArmed(ws), true);
});

test('each tab holds its own gun, and a move in one holsters the other', () => {
  const room = createInventoryRoom();
  const tab1 = socket();
  const tab2 = socket();
  room.receive(tab1, hello(KEY_A));
  room.receive(tab2, hello(KEY_A));
  room.receive(tab1, equip(0));
  assert.equal(room.isArmed(tab1), true);
  assert.equal(room.isArmed(tab2), false);
  room.receive(tab2, move('hotbar', 0, 'hotbar', 3));
  assert.equal(room.isArmed(tab1), false);
  assert.equal(tab1.last.held, null);
});

// Shared containers

const open = (container) => ({ type: 'blort-inventory-open', container });
const LOOT = {
  id: 'test-loot',
  kind: 'loot',
  x: 0.5,
  z: 17.5,
  yaw: 0,
  lootTable: 'basic',
};
const CHEST = { id: 'test-chest', kind: 'chest', x: 4.5, z: 17.5, yaw: 0 };

/** The last message of a type a socket was sent. */
const latest = (ws, type = 'blort-inventory') =>
  ws.sent.findLast((m) => m.type === type);

const filled = (slots) => slots.filter(Boolean);

function containerRoom(options = {}) {
  const positions = new Map();
  const room = createInventoryRoom({
    containers: [LOOT, CHEST],
    positionOf: (ws) => positions.get(ws),
    random: () => 0.99, // 3 items, the last ones in each pick
    ...options,
  });
  /** Stands a socket's player on the ground at x, z. */
  const standAt = (ws, x, z) => positions.set(ws, { x, y: ground(x, z), z });
  /** A connected player standing beside the loot chest. */
  function join(key, x = LOOT.x + 1, z = LOOT.z) {
    const ws = socket();
    standAt(ws, x, z);
    room.receive(ws, hello(key));
    return ws;
  }
  return { room, join, standAt };
}

test('hello lists every container with its lid shut', () => {
  const { join } = containerRoom();
  const ws = join(KEY_A);
  const { containers } = latest(ws, 'blort-inventory-world');
  assert.deepEqual(
    containers.map(({ id, kind, open }) => ({ id, kind, open })),
    [
      { id: 'test-loot', kind: 'loot', open: false },
      { id: 'test-chest', kind: 'chest', open: false },
    ],
  );
  assert.equal(containers[0].y, ground(LOOT.x, LOOT.z));
  assert.equal(latest(ws).container, null);
});

test('a loot chest fills on first open and never rolls again', () => {
  let rolls = 0;
  const { room, join } = containerRoom({
    random: () => {
      rolls++;
      return 0.99;
    },
  });
  const a = join(KEY_A);
  const b = join(KEY_B);
  room.receive(a, open('test-loot'));
  const first = latest(a).container;
  assert.equal(first.id, 'test-loot');
  assert.equal(first.kind, 'loot');
  assert.equal(filled(first.slots).length, 3);
  const used = rolls;
  room.receive(a, open(null));
  room.receive(b, open('test-loot'));
  assert.deepEqual(latest(b).container.slots, first.slots);
  assert.equal(rolls, used, 'no second roll');
});

test('opening and closing swings the lid for everyone', () => {
  const { room, join } = containerRoom();
  const a = join(KEY_A);
  const b = join(KEY_B);
  const lid = (ws) =>
    latest(ws, 'blort-inventory-world').containers.find(
      (c) => c.id === 'test-loot',
    ).open;
  room.receive(a, open('test-loot'));
  assert.equal(lid(b), true);
  room.receive(a, open(null));
  assert.equal(lid(b), false);
  assert.equal(latest(a).container, null);
  room.receive(a, open('test-loot'));
  room.disconnect(a);
  assert.equal(lid(b), false, 'leaving shuts it');
});

test('loot can be taken but nothing goes in or moves around', () => {
  const { room, join } = containerRoom();
  const ws = join(KEY_A);
  room.receive(ws, open('test-loot'));
  const before = latest(ws).container.slots;
  room.receive(ws, move('hotbar', 1, 'container', 5)); // put the lantern in
  room.receive(ws, move('container', 0, 'container', 6)); // rearrange
  assert.deepEqual(latest(ws).container.slots, before);
  assert.equal(latest(ws).hotbar[1].itemId, 'lantern');

  const taken = before[0];
  room.receive(ws, move('container', 0, 'backpack', 23));
  assert.equal(latest(ws).container.slots[0], null);
  assert.deepEqual(latest(ws).backpack[23], taken);
});

test('taking loot onto a different item does not swap it in', () => {
  const { room, join } = containerRoom();
  const ws = join(KEY_A);
  room.receive(ws, open('test-loot'));
  const before = latest(ws).container.slots;
  const lantern = latest(ws).hotbar[1];
  const index = before.findIndex((slot) => slot && slot.itemId !== 'lantern');
  room.receive(ws, move('container', index, 'hotbar', 1));
  assert.deepEqual(latest(ws).container.slots, before);
  assert.deepEqual(latest(ws).hotbar[1], lantern);
});

test('everyone looking in sees a take as it happens', () => {
  const { room, join } = containerRoom();
  const a = join(KEY_A);
  const b = join(KEY_B);
  room.receive(a, open('test-loot'));
  room.receive(b, open('test-loot'));
  const bSent = b.sent.length;
  room.receive(a, move('container', 0, 'backpack', 23));
  assert.ok(b.sent.length > bSent);
  assert.equal(latest(b).container.slots[0], null);
  // b's own bags are untouched.
  assert.equal(latest(b).backpack[23], null);
  // And b can't take what a already has.
  room.receive(b, move('container', 0, 'backpack', 23));
  assert.equal(latest(b).backpack[23], null);
});

test('containers only open in reach, and close when you walk off', () => {
  const { room, join, standAt } = containerRoom();
  const ws = join(KEY_A, LOOT.x + 20, LOOT.z);
  room.receive(ws, open('test-loot'));
  assert.equal(latest(ws).container, null);
  room.receive(ws, open('nowhere')); // not a container at all
  assert.equal(latest(ws).container, null);

  standAt(ws, LOOT.x + 1, LOOT.z);
  room.receive(ws, open('test-loot'));
  assert.equal(latest(ws).container.id, 'test-loot');
  standAt(ws, LOOT.x + 20, LOOT.z);
  room.receive(ws, move('container', 0, 'backpack', 23));
  assert.equal(latest(ws).container, null);
  assert.equal(latest(ws).backpack[23], null);
  assert.equal(latest(ws, 'blort-inventory-world').containers[0].open, false);
});

test('moves into the container bag need an open container', () => {
  const { room, join } = containerRoom();
  const ws = join(KEY_A);
  room.receive(ws, move('hotbar', 1, 'container', 0));
  assert.equal(latest(ws).hotbar[1].itemId, 'lantern');
});

test('a plain chest takes and gives; moving the drawn gun in holsters it', () => {
  const { room, join } = containerRoom();
  const ws = join(KEY_A, CHEST.x + 1, CHEST.z);
  room.receive(ws, open('test-chest'));
  assert.deepEqual(filled(latest(ws).container.slots), [], 'starts empty');
  room.receive(ws, { type: 'blort-inventory-equip', slot: 0 });
  assert.equal(room.isArmed(ws), true);
  room.receive(ws, move('hotbar', 0, 'container', 3));
  assert.equal(latest(ws).container.slots[3].itemId, 'pistol');
  assert.equal(latest(ws).hotbar[0], null);
  assert.equal(room.isArmed(ws), false);
  room.receive(ws, move('container', 3, 'container', 7));
  room.receive(ws, move('container', 7, 'hotbar', 5));
  assert.equal(latest(ws).hotbar[5].itemId, 'pistol');
});

test('looted containers keep their contents through a restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blort-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventories.json');

  const first = containerRoom({ file, saveDelayMs: 10 });
  const ws = first.join(KEY_A);
  first.room.receive(ws, open('test-loot'));
  const rolled = latest(ws).container.slots;
  first.room.receive(ws, move('container', 0, 'backpack', 23));
  await first.room.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.containers['test-loot'].looted, true);

  let rerolled = false;
  const second = containerRoom({
    file,
    random: () => {
      rerolled = true;
      return 0;
    },
  });
  const again = second.join(KEY_A);
  second.room.receive(again, open('test-loot'));
  assert.deepEqual(latest(again).container.slots, [null, ...rolled.slice(1)]);
  assert.equal(rerolled, false);
});

test('empty inventories are never saved and never use up the cap', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'blort-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'inventories.json');
  const { room, join: joinAt } = containerRoom({
    file,
    maxSaved: 1,
    starterKit: [],
    saveDelayMs: 10,
  });
  // Lots of made-up keys that never pick anything up.
  for (let i = 0; i < 50; i++) {
    const ws = joinAt(i.toString(16).padStart(32, 'c'));
    room.disconnect(ws);
  }
  // A real player loots a chest: they get the one saved place.
  const ws = joinAt(KEY_A);
  room.receive(ws, open('test-loot'));
  room.receive(ws, move('container', 0, 'backpack', 0));
  await room.close();
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(saved.players), [KEY_A]);
});
