import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import releaseVariant from "@jitl/quickjs-wasmfile-release-sync";
import { db, forPrincipal, type Database } from "../db";
import { requireScope, requireSpace, type Principal } from "../policy";
import { canonicalJson, sha256 } from "./contracts";
import {
  grantsFor,
  loadCatalog,
  permitted,
  registerPlatformOperation,
  resolve,
  type Entry,
} from "./catalog";
import { invoke, type Receipt } from "./dispatch";
import { PlatformError, type PlatformErrorBody } from "./errors";

// execute runs a short async JavaScript function in QuickJS compiled to
// WebAssembly. The program sees only `api` (the selected operations),
// standard language built-ins and a bounded console.log: no host modules,
// filesystem, network, timers or secrets. Every api call goes back through
// invoke, with its own authorization check, validation and receipt.
export const LIMITS = {
  sourceBytes: 32 * 1024,
  wallMs: 30000,
  cpuMs: 1000,
  // Shares the server process's memory budget, so kept well under it.
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  // The whole WebAssembly heap, shared by concurrent executions. QuickJS's
  // per-runtime limit counts live bytes; this also bounds fragmentation.
  wasmPages: 3072, // 192 MiB
  calls: 50,
  concurrent: 8,
  resultBytes: 64 * 1024,
  logBytes: 8 * 1024,
};

const idempotencyKey = z
  .string()
  .min(1)
  .max(150)
  .regex(/^[\x21-\x7e]+$/, "Use printable ASCII without spaces.");
export const executeInput = z
  .object({
    catalog_revision: z
      .string()
      .regex(/^cat_[a-f0-9]{32}$/)
      .nullish(),
    space: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,47}$/)
      .nullish(),
    mode: z.enum(["read", "write"]).nullish(),
    execution_key: idempotencyKey.nullish(),
    operations: z
      .array(
        z
          .object({
            operation: z.string().max(105),
            version: z.string().max(64),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    code: z.string().min(1),
  })
  .strict();

type ProgramStatus =
  "running" | "succeeded" | "failed" | "timed_out" | "cancelled";
interface CallRecord {
  seq: number;
  operation: string;
  version: string;
  receipt_id: string | null;
  status: string;
  effect_state: string;
  error_code: string | null;
}
export interface ExecutionResult {
  execution_id: string;
  catalog_revision: string;
  status: ProgramStatus;
  result: unknown;
  error: PlatformErrorBody | null;
  logs: string[];
  calls: CallRecord[];
  effects: {
    counts: Record<string, number>;
    has_committed_effects: boolean;
    has_unsettled_calls: boolean;
  };
  replayed: boolean;
}

// One WebAssembly instance per process; each execution gets its own QuickJS
// runtime (separate heap, limits and garbage collector). If the instance ever
// aborts, it is discarded and the next execution loads a fresh one.
let quickjs: Promise<QuickJSWASMModule> | null = null;
const variant = newVariant(releaseVariant, {
  wasmMemory: async () =>
    new WebAssembly.Memory({ initial: 256, maximum: LIMITS.wasmPages }),
});
const engine = () => (quickjs ??= newQuickJSWASMModuleFromVariant(variant));
const discardEngine = () => {
  quickjs = null;
};

function effectsOf(calls: CallRecord[]): ExecutionResult["effects"] {
  const counts: Record<string, number> = {};
  for (const call of calls)
    counts[call.status] = (counts[call.status] ?? 0) + 1;
  return {
    counts,
    has_committed_effects: calls.some((call) =>
      ["committed", "partial", "unknown"].includes(call.effect_state),
    ),
    has_unsettled_calls: calls.some((call) =>
      ["running", "unknown"].includes(call.status),
    ),
  };
}

// Builds the frozen, null-prototype `api` object inside the sandbox from the
// selected operations, and helpers to move JSON across the boundary.
const BOOTSTRAP = `(function (call, log, operations) {
  const ops = JSON.parse(operations);
  const api = Object.create(null);
  for (const [app, leaf, op, version] of ops) {
    if (!api[app]) api[app] = Object.create(null);
    api[app][leaf] = (args, options) =>
      call(op, version, JSON.stringify(args === undefined ? {} : args),
        JSON.stringify(options === undefined ? {} : options));
  }
  for (const app of Object.keys(api)) Object.freeze(api[app]);
  Object.defineProperty(globalThis, "api", { value: Object.freeze(api) });
  const text = (v) => { try { return typeof v === "string" ? v : JSON.stringify(v); } catch { return String(v); } };
  Object.defineProperty(globalThis, "console", {
    value: Object.freeze({ log: (...a) => log(a.map(text).join(" ")) }),
  });
  return {
    parse: (json) => JSON.parse(json),
    error: (json) => { const d = JSON.parse(json); const e = new Error(d.message); e.name = "OperationError"; Object.assign(e, d); return e; },
    serialize: (value) => JSON.stringify(value === undefined ? null : value),
    describe: (e) => e instanceof Error ? (e.name + ": " + e.message) : text(e),
  };
})`;

export class Sandbox {
  private runtime: QuickJSRuntime;
  private context: QuickJSContext;
  private helpers: Record<
    "parse" | "error" | "serialize" | "describe",
    QuickJSHandle
  >;
  private cpuUsed = 0;
  private sliceStart = 0;
  private inSlice = false;
  private deadline: number;
  disposed = false;
  interrupted: "cpu" | "wall" | null = null;

  constructor(module: QuickJSWASMModule, wallDeadline: number) {
    this.deadline = wallDeadline;
    this.runtime = module.newRuntime();
    this.runtime.setMemoryLimit(LIMITS.memoryBytes);
    this.runtime.setMaxStackSize(LIMITS.stackBytes);
    this.runtime.setInterruptHandler(() => {
      const now = Date.now();
      if (this.inSlice && this.cpuUsed + (now - this.sliceStart) > LIMITS.cpuMs)
        this.interrupted = "cpu";
      else if (now > this.deadline) this.interrupted = "wall";
      return this.interrupted !== null;
    });
    this.context = this.runtime.newContext();
    this.helpers = {} as never;
  }

  // Run VM work, charging its time to the CPU budget.
  slice<T>(fn: () => T): T {
    // Host callbacks run inside a slice; only the outermost one is timed.
    if (this.inSlice) return fn();
    this.inSlice = true;
    this.sliceStart = Date.now();
    try {
      return fn();
    } finally {
      this.cpuUsed += Date.now() - this.sliceStart;
      this.inSlice = false;
    }
  }

  install(
    operations: [string, string, string, string][],
    call: (
      op: string,
      version: string,
      args: string,
      options: string,
    ) => QuickJSHandle,
    log: (line: string) => void,
  ) {
    const vm = this.context;
    const callFn = vm.newFunction("call", (op, version, args, options) =>
      call(
        vm.getString(op),
        vm.getString(version),
        vm.getString(args),
        vm.getString(options),
      ),
    );
    const logFn = vm.newFunction("log", (line) => {
      log(vm.getString(line));
    });
    const ops = vm.newString(JSON.stringify(operations));
    const factory = this.slice(() =>
      vm.unwrapResult(vm.evalCode(BOOTSTRAP, "bootstrap.js")),
    );
    const helpers = this.slice(() =>
      vm.unwrapResult(
        vm.callFunction(factory, vm.undefined, callFn, logFn, ops),
      ),
    );
    for (const name of ["parse", "error", "serialize", "describe"] as const)
      this.helpers[name] = vm.getProp(helpers, name);
    for (const handle of [callFn, logFn, ops, factory, helpers])
      handle.dispose();
  }

  private callHelper(name: keyof Sandbox["helpers"], text: string) {
    const vm = this.context;
    const arg = vm.newString(text);
    try {
      return this.slice(() =>
        vm.unwrapResult(vm.callFunction(this.helpers[name], vm.undefined, arg)),
      );
    } finally {
      arg.dispose();
    }
  }
  newDeferred() {
    return this.context.newPromise();
  }
  valueFromJson(json: string) {
    return this.callHelper("parse", json);
  }
  errorFromJson(json: string) {
    return this.callHelper("error", json);
  }

  start(code: string): QuickJSHandle {
    const vm = this.context;
    const fn = this.slice(() => vm.evalCode(`(${code}\n)`, "program.js"));
    if (fn.error) {
      const message = this.describe(fn.error);
      fn.error.dispose();
      throw new PlatformError(
        "INVALID_ARGUMENTS",
        `code does not compile: ${message}`,
      );
    }
    if (vm.typeof(fn.value) !== "function") {
      fn.value.dispose();
      throw new PlatformError(
        "INVALID_ARGUMENTS",
        "code must be a function expression, such as async () => { ... }.",
      );
    }
    const result = this.slice(() => vm.callFunction(fn.value, vm.undefined));
    fn.value.dispose();
    if (result.error) return this.rejected(result.error);
    return result.value;
  }
  private rejected(error: QuickJSHandle) {
    const deferred = this.context.newPromise();
    deferred.reject(error);
    error.dispose();
    const handle = deferred.handle.dup();
    deferred.dispose();
    return handle;
  }

  pump() {
    if (this.disposed) return;
    const result = this.slice(() => this.runtime.executePendingJobs());
    if (result.error) result.error.dispose();
  }

  state(
    promise: QuickJSHandle,
  ):
    | { type: "pending" }
    | { type: "fulfilled"; json: string }
    | { type: "rejected"; message: string } {
    const vm = this.context;
    const state = vm.getPromiseState(promise);
    if (state.type === "pending") return { type: "pending" };
    if (state.type === "rejected") {
      const message = this.describe(state.error);
      state.error.dispose();
      return { type: "rejected", message };
    }
    const json = this.slice(() =>
      vm.callFunction(this.helpers.serialize, vm.undefined, state.value),
    );
    state.value.dispose();
    if (json.error) {
      const message = this.describe(json.error);
      json.error.dispose();
      return {
        type: "rejected",
        message: `The result is not JSON: ${message}`,
      };
    }
    const text =
      vm.typeof(json.value) === "string" ? vm.getString(json.value) : "null";
    json.value.dispose();
    return { type: "fulfilled", json: text };
  }

  describe(handle: QuickJSHandle) {
    const vm = this.context;
    const described = vm.callFunction(
      this.helpers.describe ?? vm.undefined,
      vm.undefined,
      handle,
    );
    if (described.error) {
      described.error.dispose();
      return "Error";
    }
    const text =
      vm.typeof(described.value) === "string"
        ? vm.getString(described.value)
        : "Error";
    described.value.dispose();
    return text.slice(0, 1000);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      for (const handle of Object.values(this.helpers)) handle?.dispose();
      this.context.dispose();
      this.runtime.dispose();
    } catch {
      // A failed teardown means the WebAssembly instance may be corrupt.
      discardEngine();
    }
  }
}

interface ExecutionRow {
  id: string;
  principal_id: string;
  space: string;
  request_hash: string;
  catalog_revision: string;
  status: ProgramStatus;
  encrypted_result: string | null;
  encrypted_logs: string | null;
  error: PlatformErrorBody | string | null;
}

async function loadExecution(
  database: Database,
  principal: Principal,
  id: string,
  replayed: boolean,
): Promise<ExecutionResult | null> {
  const scoped = await forPrincipal(database, principal);
  return scoped.transaction(async (tx) => {
    const row = (
      await tx.query<ExecutionRow>(
        "SELECT id,principal_id,space,request_hash,catalog_revision,status,encrypted_result,encrypted_logs,error FROM ap_executions WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!row) return null;
    if (
      row.principal_id !== principal.id &&
      !(principal.owner && principal.userId)
    )
      return null;
    if (principal.spaces && !principal.spaces.includes(row.space)) return null;
    const calls = (
      await tx.query<CallRecord>(
        "SELECT seq,operation,version,receipt_id,status,effect_state,error_code FROM ap_execution_calls WHERE execution_id=$1 ORDER BY seq",
        [id],
      )
    ).rows;
    return {
      execution_id: row.id,
      catalog_revision: row.catalog_revision,
      status: row.status,
      result: row.encrypted_result
        ? tx.cipher!.decrypt(`execution:${row.id}:result`, row.encrypted_result)
        : null,
      error:
        typeof row.error === "string"
          ? (JSON.parse(row.error) as PlatformErrorBody)
          : row.error,
      logs: row.encrypted_logs
        ? tx.cipher!.decrypt<string[]>(
            `execution:${row.id}:logs`,
            row.encrypted_logs,
          )
        : [],
      calls,
      effects: effectsOf(calls),
      replayed,
    };
  });
}

export async function getExecution(
  principal: Principal,
  id: string,
  database: Database = db,
) {
  const parsed = z.uuid().safeParse(id);
  const found = parsed.success
    ? await loadExecution(database, principal, parsed.data, true)
    : null;
  if (!found)
    throw new PlatformError(
      "NOT_AVAILABLE",
      "No such execution is available to you.",
    );
  return found;
}

export async function execute(
  principal: Principal,
  raw: unknown,
  database: Database = db,
): Promise<ExecutionResult> {
  requireScope(principal, "astropath:read");
  const input = executeInput.parse(raw);
  if (Buffer.byteLength(input.code) > LIMITS.sourceBytes)
    throw new PlatformError("EXECUTION_LIMIT", "code is over 32 KiB.");
  const mode = input.mode ?? "read";
  const space =
    input.space ??
    (principal.spaces?.length === 1 && !principal.spaces.includes("general")
      ? principal.spaces[0]
      : "general");
  requireSpace(principal, space);
  const scoped = await forPrincipal(database, principal);

  // Preflight: every selected contract exists, is permitted, and fits the mode.
  const { revision, entries } = await scoped.transaction(async (tx) => {
    const catalog = await loadCatalog(tx);
    const grants = await grantsFor(tx, principal);
    const entries: Entry[] = [];
    const names = new Set<string>();
    for (const selected of input.operations) {
      if (names.has(selected.operation))
        throw new PlatformError(
          "INVALID_ARGUMENTS",
          `Select one version of ${selected.operation}.`,
        );
      names.add(selected.operation);
      const entry = await resolve(
        tx,
        catalog,
        input.catalog_revision ?? undefined,
        selected.operation,
        selected.version,
      );
      if (!permitted(principal, catalog, grants, entry))
        throw new PlatformError(
          "NOT_AVAILABLE",
          `${selected.operation}@${selected.version} is not available to you.`,
          "none",
          "rediscover",
        );
      if (mode === "read" && entry.contract.effect !== "read")
        throw new PlatformError(
          "INVALID_ARGUMENTS",
          `${entry.key} changes state: run with mode "write" and an execution_key.`,
        );
      entries.push(entry);
    }
    return { revision: input.catalog_revision ?? catalog.revision, entries };
  });
  if (mode === "write" && !input.execution_key)
    throw new PlatformError(
      "INVALID_ARGUMENTS",
      "Write mode needs an execution_key; reuse it only to retrieve this same execution.",
    );
  const codeHash = sha256(input.code);
  const requestHash = sha256(
    canonicalJson({
      code: codeHash,
      operations: entries.map((entry) => entry.key).sort(),
      catalog: revision,
      space,
      mode,
    }),
  );

  // Reserve the execution before any callback can begin.
  const executionId = randomUUID();
  const reserved = await scoped.transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO ap_executions(id,principal_id,principal_name,space,mode,execution_key,request_hash,code_hash,catalog_revision,status,encrypted_source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10)
       ON CONFLICT (tenant_id,principal_id,execution_key) DO NOTHING RETURNING id`,
      [
        executionId,
        principal.id,
        principal.name,
        space,
        mode,
        input.execution_key ?? null,
        requestHash,
        codeHash,
        revision,
        tx.cipher!.encrypt(`execution:${executionId}:source`, input.code),
      ],
    );
    if (inserted.rows.length) return null;
    const existing = (
      await tx.query<{ id: string; request_hash: string }>(
        "SELECT id,request_hash FROM ap_executions WHERE principal_id=$1 AND execution_key=$2",
        [principal.id, input.execution_key],
      )
    ).rows[0];
    if (existing.request_hash !== requestHash)
      throw new PlatformError(
        "IDEMPOTENCY_CONFLICT",
        "This execution_key was used for a different program, operation set, catalog, space or mode.",
      );
    return existing.id;
  });
  // The same key returns the existing execution; it never runs twice.
  if (reserved)
    return (await loadExecution(database, principal, reserved, true))!;

  const started = Date.now();
  const deadline = started + LIMITS.wallMs;
  const logs: string[] = [];
  let logBytes = 0;
  const calls: CallRecord[] = [];
  const inFlight = new Set<Promise<void>>();
  let accepting = true;
  let active = 0;
  const waiting: (() => void)[] = [];
  const byKey = new Map(
    entries.map((entry) => [
      `${entry.contract.operation}@${entry.contract.version}`,
      entry,
    ]),
  );

  const sandbox = new Sandbox(await engine(), deadline);
  let wake: () => void = () => {};
  const recordCall = async (call: CallRecord, insert: boolean) => {
    await scoped.query(
      insert
        ? `INSERT INTO ap_execution_calls(execution_id,seq,operation,version,receipt_id,status,effect_state,error_code)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`
        : `UPDATE ap_execution_calls SET receipt_id=$5,status=$6,effect_state=$7,error_code=$8,updated_at=now()
           WHERE execution_id=$1 AND seq=$2 AND operation=$3 AND version=$4`,
      [
        executionId,
        call.seq,
        call.operation,
        call.version,
        call.receipt_id,
        call.status,
        call.effect_state,
        call.error_code,
      ],
    );
  };

  const hostCall = (
    op: string,
    version: string,
    argsJson: string,
    optionsJson: string,
  ) => {
    const deferred = sandbox.newDeferred();
    const handle = deferred.handle.dup();
    const fail = (
      error: PlatformErrorBody & {
        receipt_id?: string | null;
        status?: string;
      },
    ) => {
      if (sandbox.disposed) return;
      const value = sandbox.errorFromJson(JSON.stringify(error));
      deferred.reject(value);
      value.dispose();
      deferred.dispose();
      sandbox.pump();
      wake();
    };
    const entry = byKey.get(`${op}@${version}`);
    if (!accepting || calls.length >= LIMITS.calls) {
      queueMicrotask(() =>
        fail({
          code: "EXECUTION_LIMIT",
          message: accepting
            ? `A program can make at most ${LIMITS.calls} calls.`
            : "The program has finished; no further calls are dispatched.",
          effect_state: "none",
          retry_advice: "do_not_retry",
        }),
      );
      return handle;
    }
    if (!entry) {
      queueMicrotask(() =>
        fail({
          code: "NOT_AVAILABLE",
          message: `${op}@${version} was not selected for this execution.`,
          effect_state: "none",
          retry_advice: "do_not_retry",
        }),
      );
      return handle;
    }
    const call: CallRecord = {
      seq: calls.length + 1,
      operation: op,
      version,
      receipt_id: null,
      status: "running",
      effect_state: "none",
      error_code: null,
    };
    calls.push(call);
    const task = (async () => {
      // At most LIMITS.concurrent calls are in flight; the rest queue.
      while (active >= LIMITS.concurrent)
        await new Promise<void>((resolve) => waiting.push(resolve));
      active++;
      let receipt: Receipt | null = null;
      let thrown: PlatformErrorBody | null = null;
      try {
        await recordCall(call, true);
        const options = JSON.parse(optionsJson) as {
          idempotency_key?: unknown;
        };
        receipt = await invoke(
          principal,
          {
            catalog_revision: revision,
            operation: op,
            version,
            space,
            arguments: JSON.parse(argsJson),
            ...(typeof options.idempotency_key === "string"
              ? { idempotency_key: options.idempotency_key }
              : {}),
          },
          database,
        );
      } catch (error) {
        thrown =
          error instanceof PlatformError
            ? error.body()
            : {
                code: "INVALID_ARGUMENTS",
                message:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : "Invalid call.",
                effect_state: "none",
                retry_advice: "do_not_retry",
              };
      } finally {
        active--;
        waiting.shift()?.();
      }
      call.receipt_id = receipt?.receipt_id ?? null;
      call.status = receipt?.status ?? "failed";
      call.effect_state = receipt
        ? (receipt.error?.effect_state ??
          (entry.contract.effect !== "read" ? "committed" : "none"))
        : (thrown?.effect_state ?? "none");
      call.error_code = receipt?.error?.code ?? thrown?.code ?? null;
      await recordCall(call, false).catch(() => {});
      if (sandbox.disposed) return;
      if (
        receipt &&
        (receipt.status === "succeeded" || receipt.status === "accepted")
      ) {
        const value = sandbox.valueFromJson(
          JSON.stringify(receipt.result ?? null),
        );
        deferred.resolve(value);
        value.dispose();
        deferred.dispose();
        sandbox.pump();
        wake();
      } else
        fail({
          ...(receipt?.error ??
            thrown ?? {
              code: "OUTCOME_UNKNOWN",
              message: "The operation is still running.",
              effect_state: "unknown",
              retry_advice: "reconcile",
            }),
          receipt_id: receipt?.receipt_id ?? null,
          status: receipt?.status ?? "failed",
        });
    })();
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
    return handle;
  };

  let status: ProgramStatus = "failed";
  let result: unknown = null;
  let error: PlatformErrorBody | null = null;
  try {
    sandbox.install(
      entries.map((entry) => {
        const [app, leaf] = entry.contract.operation.split(".");
        return [app, leaf, entry.contract.operation, entry.contract.version];
      }),
      hostCall,
      (line) => {
        if (logBytes >= LIMITS.logBytes) return;
        const kept = line.slice(0, LIMITS.logBytes - logBytes);
        logBytes += Buffer.byteLength(kept);
        logs.push(kept);
      },
    );
    const promise = sandbox.start(input.code);
    sandbox.pump();
    const outcome = await new Promise<ReturnType<Sandbox["state"]> | "timeout">(
      (resolve) => {
        const timer = setTimeout(
          () => resolve("timeout"),
          Math.max(0, deadline - Date.now()),
        );
        wake = () => {
          if (sandbox.interrupted) {
            clearTimeout(timer);
            resolve("timeout");
            return;
          }
          const state = sandbox.state(promise);
          if (state.type !== "pending") {
            clearTimeout(timer);
            resolve(state);
          }
        };
        wake();
      },
    );
    // Calls that settle while draining must not touch the finished promise.
    wake = () => {};
    if (!sandbox.disposed) promise.dispose();
    if (outcome === "timeout" || sandbox.interrupted) {
      status = "timed_out";
      error = {
        code: "EXECUTION_LIMIT",
        message:
          sandbox.interrupted === "cpu"
            ? `The program used more than ${LIMITS.cpuMs} ms of CPU.`
            : `The program did not finish within ${LIMITS.wallMs / 1000} seconds.`,
        effect_state: "unknown",
        retry_advice: "reconcile",
      };
    } else if (outcome.type === "rejected") {
      status = "failed";
      const memory = /out of memory/i.test(outcome.message);
      error = {
        code: memory ? "EXECUTION_LIMIT" : "PROGRAM_ERROR",
        message: memory
          ? "The program ran out of memory (64 MiB)."
          : outcome.message,
        effect_state: "unknown",
        retry_advice: "reconcile",
      };
    } else if (outcome.type === "fulfilled") {
      if (Buffer.byteLength(outcome.json) > LIMITS.resultBytes) {
        status = "failed";
        error = {
          code: "EXECUTION_LIMIT",
          message: "The result is over 64 KiB. Return a smaller summary.",
          effect_state: "unknown",
          retry_advice: "reconcile",
        };
      } else {
        status = "succeeded";
        result = JSON.parse(outcome.json);
      }
    }
  } catch (caught) {
    status = "failed";
    error =
      caught instanceof PlatformError
        ? caught.body()
        : {
            code: "PROGRAM_ERROR",
            message:
              caught instanceof Error
                ? caught.message.slice(0, 1000)
                : "The program failed.",
            effect_state: "unknown",
            retry_advice: "reconcile",
          };
  }
  // Stop dispatch, then let already-issued calls settle within the deadline.
  accepting = false;
  if (inFlight.size)
    await Promise.race([
      Promise.allSettled([...inFlight]),
      new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline - Date.now())),
      ),
    ]);
  sandbox.dispose();
  if (error && calls.length === 0) error = { ...error, effect_state: "none" };
  else if (
    error &&
    !effectsOf(calls).has_committed_effects &&
    !effectsOf(calls).has_unsettled_calls
  )
    error = { ...error, effect_state: "none" };
  await scoped.transaction(async (tx) => {
    await tx.query(
      `UPDATE ap_executions SET status=$2,encrypted_result=$3,encrypted_logs=$4,error=$5,finished_at=now() WHERE id=$1`,
      [
        executionId,
        status,
        result === null
          ? null
          : tx.cipher!.encrypt(`execution:${executionId}:result`, result),
        logs.length
          ? tx.cipher!.encrypt(`execution:${executionId}:logs`, logs)
          : null,
        error ? JSON.stringify(error) : null,
      ],
    );
  });
  return {
    execution_id: executionId,
    catalog_revision: revision,
    status,
    result,
    error,
    logs,
    calls: calls.map((call) => ({ ...call })),
    effects: effectsOf(calls),
    replayed: false,
  };
}

registerPlatformOperation({
  input: z.object({ execution_id: z.string().max(100) }).strict(),
  handler: (principal, args) =>
    getExecution(principal, String(args.execution_id)),
  contract: {
    operation: "platform.get_execution",
    version: "1.0.0",
    app: "platform",
    summary:
      "Look up an earlier execute run: its status, result, logs and the ledger of operations it called.",
    description:
      "Calls still running when the program ended keep updating here until they settle.",
    effect: "read",
    execution: "sync",
    idempotency: "optional",
    sensitive: false,
    deprecated: null,
    input_schema: {
      type: "object",
      properties: { execution_id: { type: "string", maxLength: 100 } },
      required: ["execution_id"],
      additionalProperties: false,
    },
    output_schema: { type: "object" },
    examples: [],
    ui_url: null,
  },
});
