export function createCodexPool(capacity = 3) {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new TypeError("Codex pool capacity must be a positive integer.");
  }
  let active = 0;
  let nextId = 1;
  const queue = [];

  function drain() {
    while (active < capacity && queue.length > 0) {
      const entry = queue.shift();
      active += 1;
      entry.ticket.state = "running";
      try {
        entry.onStart?.();
      } catch (error) {
        active -= 1;
        entry.ticket.state = "failed";
        entry.reject(error);
        continue;
      }
      Promise.resolve()
        .then(entry.task)
        .then(
          (value) => {
            active -= 1;
            entry.ticket.state = "completed";
            drain();
            entry.resolve(value);
          },
          (error) => {
            active -= 1;
            entry.ticket.state = "failed";
            drain();
            entry.reject(error);
          },
        );
    }
  }

  function submit(task, { onStart } = {}) {
    if (typeof task !== "function") {
      throw new TypeError("Codex pool task must be a function.");
    }
    const ticket = { id: `codex-${nextId}`, state: "queued", promise: null };
    nextId += 1;
    ticket.promise = new Promise((resolve, reject) => {
      queue.push({ task, onStart, resolve, reject, ticket });
      drain();
    });
    return ticket;
  }

  function snapshot() {
    return {
      active,
      capacity,
      queued: queue.map(({ ticket }) => ticket.id),
    };
  }

  return Object.freeze({ snapshot, submit });
}

export const globalCodexPool = createCodexPool(3);
