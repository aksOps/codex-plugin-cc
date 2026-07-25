import assert from "node:assert/strict";
import test from "node:test";

import { createCodexPool } from "../src/fleet/pool.mjs";
import { createScheduler } from "../src/fleet/scheduler.mjs";

const plan = {
  intent: "schedule safely",
  steps: [
    {
      id: "base",
      dependencies: [],
      files: ["base.txt"],
    },
    {
      id: "left",
      dependencies: ["base"],
      files: ["left.txt"],
    },
    {
      id: "right",
      dependencies: ["base"],
      files: ["right.txt"],
    },
    {
      id: "overlap",
      dependencies: ["base"],
      files: ["left.txt"],
    },
  ],
};

test("scheduler admits dependencies only after pass or unverified", () => {
  // Given
  const scheduler = createScheduler(plan);

  // When / Then
  assert.throws(() => scheduler.start("left", 1), /dependencies.*base/i);
  scheduler.start("base", 1);
  scheduler.complete("base", 1, "fail", { retry: true });
  assert.throws(() => scheduler.start("left", 1), /dependencies.*base/i);
  scheduler.start("base", 2);
  scheduler.complete("base", 2, "unverified");
  assert.equal(scheduler.start("left", 1).state, "active");
});

test("scheduler admits independent disjoint Steps and refuses active overlap", () => {
  // Given
  const scheduler = createScheduler(plan, [
    { stepId: "base", rung: 1, outcome: "pass" },
  ]);

  // When
  scheduler.start("left", 1);
  const right = scheduler.start("right", 1);

  // Then
  assert.equal(right.state, "active");
  assert.throws(() => scheduler.start("overlap", 1), /overlap.*left\.txt/i);
});

test("scheduler rejects double-start, double-check, and terminal transitions", () => {
  // Given
  const scheduler = createScheduler(plan);

  // When
  scheduler.start("base", 1);

  // Then
  assert.throws(() => scheduler.start("base", 1), /active/i);
  scheduler.complete("base", 1, "pass");
  assert.throws(() => scheduler.complete("base", 1, "pass"), /terminal/i);
  assert.throws(() => scheduler.start("base", 2), /terminal/i);
});

test("scheduler reconstructs dependency completion from durable Events", () => {
  // Given
  const scheduler = createScheduler(plan, [
    { stepId: "base", rung: 1, outcome: "fail" },
    { stepId: "base", rung: 2, outcome: "pass" },
  ]);

  // When
  const admitted = scheduler.start("left", 1);

  // Then
  assert.equal(admitted.state, "active");
  assert.equal(scheduler.snapshot().steps.base.state, "pass");
});

test("Codex pool is FIFO, caps active work at three, and exposes queue state", async () => {
  // Given
  const pool = createCodexPool(3);
  const releases = [];
  const started = [];
  const tickets = Array.from({ length: 4 }, (_, index) =>
    pool.submit(async () => {
      started.push(index);
      await new Promise((resolve) => {
        releases[index] = resolve;
      });
      return index;
    }),
  );
  await Promise.resolve();

  // When
  const queued = pool.snapshot();

  // Then
  assert.deepEqual(started, [0, 1, 2]);
  assert.equal(queued.active, 3);
  assert.deepEqual(queued.queued, [tickets[3].id]);
  releases[0]();
  assert.equal(await tickets[0].promise, 0);
  assert.deepEqual(started, [0, 1, 2, 3]);
  releases[1]();
  releases[2]();
  releases[3]();
  assert.deepEqual(await Promise.all(tickets.slice(1).map(({ promise }) => promise)), [1, 2, 3]);
});

test("Codex pool releases a thrown worker slot to the next FIFO attempt", async () => {
  // Given
  const pool = createCodexPool(1);
  let release;
  const first = pool.submit(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    throw new Error("worker exploded");
  });
  const second = pool.submit(async () => "next");
  await Promise.resolve();

  // When
  release();

  // Then
  await assert.rejects(first.promise, /worker exploded/);
  assert.equal(await second.promise, "next");
  assert.deepEqual(pool.snapshot(), { active: 0, capacity: 1, queued: [] });
});

test("Codex pool rejects a throwing onStart and releases the next FIFO ticket", async () => {
  // Given
  const pool = createCodexPool(1);
  const first = pool.submit(async () => "must not run", {
    onStart: () => {
      throw new Error("start hook exploded");
    },
  });
  const second = pool.submit(async () => "next");

  // When / Then
  assert.equal(first.state, "failed");
  assert.equal(pool.snapshot().active, 1);
  await assert.rejects(first.promise, /start hook exploded/);
  assert.equal(await second.promise, "next");
  assert.deepEqual(pool.snapshot(), { active: 0, capacity: 1, queued: [] });
});

test("scheduler rejects stale Events after a terminal outcome", () => {
  // Given / When / Then
  assert.throws(
    () =>
      createScheduler(plan, [
        { stepId: "base", rung: 1, outcome: "pass" },
        { stepId: "base", rung: 1, outcome: "fail" },
      ]),
    /terminal.*Event|stale/i,
  );
});

test("scheduler accepts an explicit same-rung guardrail halt override", () => {
  // Given
  const scheduler = createScheduler(plan, [
    { stepId: "base", rung: 1, outcome: "pass" },
    {
      stepId: "base",
      rung: 1,
      outcome: "halt",
      guardrail: "child-worktree",
    },
  ]);

  // When / Then
  assert.equal(scheduler.snapshot().steps.base.state, "halt");
});
