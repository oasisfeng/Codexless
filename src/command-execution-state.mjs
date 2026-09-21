import { randomUUID } from "node:crypto";

export const DEFAULT_ASYNC_COMMAND_MAX_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_COMMAND_RESULT_TTL_MS = 60 * 60_000;
export const DEFAULT_MAX_TERMINAL_COMMANDS = 100;

export function createCommandExecutionState({
  executor,
  maxConcurrent,
  terminalTtlMs = DEFAULT_COMMAND_RESULT_TTL_MS,
  maxTerminalCommands = DEFAULT_MAX_TERMINAL_COMMANDS,
} = {}) {
  if (!executor || typeof executor.exec !== "function") throw new Error("command execution state requires executor.exec");
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("maxConcurrent must be a positive integer");
  if (!Number.isInteger(terminalTtlMs) || terminalTtlMs <= 0) throw new Error("terminalTtlMs must be a positive integer");
  if (!Number.isInteger(maxTerminalCommands) || maxTerminalCommands < 1) throw new Error("maxTerminalCommands must be a positive integer");

  let accepting = true;
  let inFlight = 0;
  const active = new Set();
  const jobs = new Map();

  function release(execution) {
    if (!active.delete(execution)) return;
    inFlight -= 1;
  }

  function admit(input) {
    if (!accepting) throw new Error("command execution is draining");
    if (inFlight >= maxConcurrent) throw new Error(`bridge concurrency limit reached (${maxConcurrent})`);
    inFlight += 1;
    const execution = Promise.resolve().then(() => executor.exec(input));
    active.add(execution);
    execution.then(
      () => release(execution),
      () => release(execution)
    );
    return execution;
  }

  function retireJob(commandRef, job) {
    const current = jobs.get(commandRef);
    if (current !== job || current.status === "running") return;
    jobs.delete(commandRef);
    if (job.retireTimer) clearTimeout(job.retireTimer);
  }

  function trimTerminalJobs() {
    const terminal = [...jobs.entries()]
      .filter(([, job]) => job.status !== "running")
      .sort((left, right) => left[1].completedAt - right[1].completedAt);
    while (terminal.length > maxTerminalCommands) {
      const [commandRef, job] = terminal.shift();
      retireJob(commandRef, job);
    }
  }

  function settle(commandRef, job, terminal) {
    if (jobs.get(commandRef) !== job || job.status !== "running") return;
    job.status = terminal.status;
    job.completedAt = Date.now();
    job.result = terminal.result ?? null;
    job.error = terminal.error ?? null;
    job.execution = null;
    job.retireTimer = setTimeout(() => retireJob(commandRef, job), terminalTtlMs);
    job.retireTimer.unref?.();
    trimTerminalJobs();
  }

  function start(input) {
    const commandRef = `cmd_${randomUUID()}`;
    const job = {
      commandRef,
      status: "running",
      input: structuredClone(input),
      startedAt: Date.now(),
      completedAt: null,
      result: null,
      error: null,
      execution: null,
      retireTimer: null,
    };
    const execution = admit(input);
    job.execution = execution;
    jobs.set(commandRef, job);
    execution.then(
      (result) => settle(commandRef, job, { status: "completed", result }),
      (error) => settle(commandRef, job, { status: "failed", error: serializeError(error) })
    );
    return { status: "running", commandRef, startedAt: job.startedAt };
  }

  function poll(commandRef) {
    const job = jobs.get(commandRef);
    if (!job) throw new Error(`unknown or expired commandRef: ${commandRef}`);
    if (job.status === "running") {
      return { status: "running", commandRef, startedAt: job.startedAt, input: structuredClone(job.input) };
    }
    return {
      status: job.status,
      commandRef,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      input: structuredClone(job.input),
      result: job.result === null ? null : structuredClone(job.result),
      error: job.error === null ? null : structuredClone(job.error),
    };
  }

  async function drain() {
    if (!accepting) {
      while (active.size) await Promise.allSettled([...active]);
      return;
    }
    accepting = false;
    while (active.size) await Promise.allSettled([...active]);
    for (const job of jobs.values()) if (job.retireTimer) clearTimeout(job.retireTimer);
    jobs.clear();
  }

  return {
    exec: (input) => admit(input),
    start,
    poll,
    drain,
  };
}

function serializeError(error) {
  const payload = { error: error instanceof Error ? error.message : String(error) };
  if (error && typeof error === "object") {
    if (typeof error.code === "string") payload.errorCode = error.code;
    if (Array.isArray(error.nextActions) && error.nextActions.every((value) => typeof value === "string")) {
      payload.nextActions = [...error.nextActions];
    }
  }
  return payload;
}
