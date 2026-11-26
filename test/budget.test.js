import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryBudget } from '../src/budget.js';

test('budget grants up to capacity then denies', () => {
  let t = 0;
  const b = new RetryBudget({ capacity: 3, refillPerSecond: 1, now: () => t });
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  const snap = b.snapshot();
  assert.equal(snap.granted, 3);
  assert.equal(snap.denied, 1);
  assert.equal(snap.tokens, 0);
});

test('budget refills continuously and never exceeds capacity', () => {
  let t = 0;
  const b = new RetryBudget({ capacity: 5, refillPerSecond: 2, now: () => t });
  for (let i = 0; i < 5; i++) assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  t = 1000; // 2 tokens after a second
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), true);
  assert.equal(b.tryTake(), false);
  t = 10_000;
  b.refill();
  assert.ok(b.tokens <= 5);
  assert.equal(b.snapshot().tokens, 5);
});

test('concurrent weak failures share one budget', () => {
  // Eight simultaneous failures, three tokens: the cap is global, not per-request.
  let t = 0;
  const b = new RetryBudget({ capacity: 3, refillPerSecond: 0, now: () => t });
  let granted = 0;
  let denied = 0;
  for (let i = 0; i < 8; i++) {
    if (b.tryTake()) granted++;
    else denied++;
  }
  assert.equal(granted, 3);
  assert.equal(denied, 5);
  assert.equal(granted + denied, 8);
  const snap = b.snapshot();
  assert.equal(snap.tokens, 0);
});
