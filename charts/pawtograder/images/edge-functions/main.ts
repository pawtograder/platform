// Main service for the self-hosted Pawtograder edge-runtime image.
//
// edge-runtime accepts one HTTP request and routes it to a per-function
// worker based on the first path segment after `/`. All 49 pawtograder
// functions set `verify_jwt = false` and validate auth in-function, so
// this main service does no JWT verification — it's a thin demuxer.
//
// === eszip loading (the per-isolate memory fix) ===
// Each function is pre-bundled into an `.eszip` at image build time
// (see the Dockerfile bundler stage). We hand those bytes to
// userWorkers.create() via maybeEszip/maybeEntrypoint instead of pointing
// the worker at raw .ts on disk. This matters because raw servicePath mode
// makes every isolate fetch its remote deps (octokit, supabase-js, sentry…)
// over the network and run the Deno transpiler, holding the whole TS source
// graph in the isolate heap — measured at ~150–250MB for a heavy function
// like autograder-create-submission, which sits right at the 256MB cap and
// tips over under burst. eszip ships the graph pre-transpiled and vendored,
// so the same function's isolates measured ~16–20MB marginal each (4 heavy
// isolates: 243MB raw → 100MB eszip). This is how supabase.com fits the same
// function under far higher load at the same 256MB ceiling.
//
// If an eszip is missing for a requested function we fall back to raw
// servicePath so the demuxer still works (e.g. a function added without a
// rebundle) — just without the memory win.
//
// === worker lifecycle ===
// It mirrors the worker lifecycle handling of supabase's stock main service
// (examples/main/index.ts): per-worker isolates are reused across requests
// and the runtime *retires* one when it nears its memory / CPU-time /
// wall-clock limit. The critical part is retrying `WorkerAlreadyRetired` on a
// fresh worker — without it, a request that lands on an about-to-die worker
// just fails. CPU-time soft/hard limits let the runtime retire busy workers
// gracefully rather than only ever killing on a hard memory hit mid-request.
//
// All limits are env-tunable (no rebuild needed to adjust):
//   EDGE_WORKER_MEMORY_LIMIT_MB (default 256, matches supabase.com)
//   EDGE_WORKER_TIMEOUT_MS      (default 400000 = 400s worker lifetime)
//   EDGE_WORKER_CPU_SOFT_MS     (default 2000 — matches hosted's 2s; graceful retire → frequent recycling)
//   EDGE_WORKER_CPU_HARD_MS     (default 5000 — hard kill with headroom; CPU time excludes async I/O)
//   EDGE_WORKER_LOW_MEMORY_MULTIPLIER (default 2 — memory early-drop at ~50%, the hosted "EarlyDrop")
//   EDGE_ESZIP_DIR              (default /home/deno/eszips — where build-time bundles live)
//
// === /metrics ===
// The edge runtime serves NO Prometheus metrics of its own. `/metrics` on the
// http port is routed like any other function, to the `metrics` user worker
// (supabase/functions/metrics/index.ts), which emits the pawtograder_* queue and
// circuit-breaker series. This demuxer APPENDS its own pawtograder_edge_*
// exposition to that response before returning it — see the collector below and
// the interception at the bottom of this file. METRICS_TOKEN is enforced by the
// user worker, which is why the append happens only on a 200.
//
//   EDGE_METRICS                (default off; chart: edgeFunctions.metrics.enabled)
//   EDGE_METRICS_BUCKETS        (comma-separated seconds; default tops out at 400s = the worker lifetime)
//
// This file is COPYed into /home/deno/functions/main/index.ts at image
// build time.

console.log("pawtograder edge-functions main started");

const MEMORY_LIMIT_MB = Number(Deno.env.get("EDGE_WORKER_MEMORY_LIMIT_MB")) || 256;
const WORKER_TIMEOUT_MS = Number(Deno.env.get("EDGE_WORKER_TIMEOUT_MS")) || 400 * 1000;
const CPU_SOFT_MS = Number(Deno.env.get("EDGE_WORKER_CPU_SOFT_MS")) || 2000;
const CPU_HARD_MS = Number(Deno.env.get("EDGE_WORKER_CPU_HARD_MS")) || 5000;
// Memory early-drop (the hosted "EarlyDrop" behaviour). When an isolate's memory
// crosses ~memoryLimitMb/lowMemoryMultiplier it FINISHES the current request and
// then retires — so a memory-heavy request (e.g. a grader tarball download)
// completes and returns a valid response instead of being force-killed when it
// would otherwise reach the hard memoryLimitMb mid-request. 2 ≈ hosted's "50% of
// any resource" threshold (~128MB at a 256MB limit). Without this the isolate
// has no memory soft limit and runs straight into the hard cap.
const LOW_MEMORY_MULTIPLIER = Number(Deno.env.get("EDGE_WORKER_LOW_MEMORY_MULTIPLIER")) || 2;
// Where the build-time eszip bundles live (one <function>.eszip per function).
const ESZIP_DIR = Deno.env.get("EDGE_ESZIP_DIR") || "/home/deno/eszips";
// Bound the retry recursion so a genuinely broken function can't loop forever.
const MAX_RETIRED_RETRIES = 5;

// Per-request access log: one line per request tagged with the function name so
// logs are filterable BY function in Loki/Grafana/`scripts/edge-logs.sh`
// (`{component="functions"} |= "[fn=<name>]"`). All functions land in this one
// pod's stdout behind the demuxer, so without this tag you can't isolate one.
// `<name>` here is `serviceName` (the path segment). The dashboard's $fn
// dropdown is built from the matching Prometheus label,
// pawtograder_edge_requests_total{function=...}, which this file produces (see
// the collector below) — with one difference that matters when correlating the
// two: the log tag is the RAW path segment, while the metric label is collapsed
// to "_unknown" for anything outside the boot-time allowlist. Set
// EDGE_ACCESS_LOG=0 to silence the log (no rebuild).
const ACCESS_LOG = (Deno.env.get("EDGE_ACCESS_LOG") ?? "1") !== "0";

// Resident eszip bytes, keyed by function name, bounded by total BYTES held.
//
// 2026-08-19: this was an unbounded `Map<string, Promise<Uint8Array>>` and it
// was the edge tier's memory problem. Every eszip a pod had ever served stayed
// pinned in this main isolate, which lives as long as the pod, so RSS was
// "floor + whatever the pod happened to have served" and it climbed for days:
// 87Mi at startup, 667Mi at 1h, 1868-2408Mi at ~5d. The giveaway was that the
// spread across SAME-AGE pods tracked distinct functions served, not uptime and
// not request count — four 25-minute-old pods sat at 210/336/398/486Mi holding
// 2/3/3/4 functions. The ceiling is the whole bundle (`[bundle] done: 55 eszips,
// 2.2G total`, see the Dockerfile), and 2.2G of cache plus 8 admitted isolates
// at 256Mi each does not fit in the 4Gi container limit. That is the OOMKill:
// the limit was never a backstop, it was a deadline.
//
// Three structures now, because the three cases have genuinely different
// lifetimes and conflating them is what made the leak invisible:
//   * `inflight` preserves the ORIGINAL coalescing property this cache existed
//     for: concurrent first-requests for one function share a single disk read
//     instead of each allocating its own ~40MB buffer. Entries are dropped on
//     settle, so it holds at most `--max-parallelism` promises.
//   * `missing` is the negative cache. No eszip on disk means fall back to raw
//     servicePath; remembering that costs a string and saves a stat per
//     request, so it is kept for the pod's life. Note it is now populated ONLY
//     on NotFound — the old code cached the null from ANY read error, so one
//     transient EIO downgraded a function to raw servicePath permanently.
//   * `resident` is the positive cache: an LRU bounded by BYTES, not by entry
//     count. Entries run 19-59MB and averaging them is how you get surprised.
// Eviction is always safe: an in-progress worker creation already holds its own
// reference to the Uint8Array, so evicting only drops OURS.
// A budget that isn't a finite positive number isn't a budget. `Number("Infinity")`
// is Infinity, which makes the eviction condition unsatisfiable and quietly
// restores the unbounded cache this whole mechanism exists to remove; `Number("")`
// and `Number("abc")` are 0 and NaN, which break it the other way (NaN comparisons
// are false, so the evict loop empties the cache on every admit). Anything not
// finite and positive falls back to the default and says so.
function byteBudget(envName: string, fallback: number): number {
  const raw = Deno.env.get(envName);
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(
      `${envName}=${JSON.stringify(raw)} is not a finite positive byte count; using ${fallback}`
    );
    return fallback;
  }
  return Math.floor(parsed);
}

const ESZIP_CACHE_MAX_BYTES = byteBudget("EDGE_ESZIP_CACHE_MAX_BYTES", 512 * 1024 * 1024);

// Aggregate ceiling on bundle bytes held OUTSIDE the resident cache: a bundle
// being read on a cache miss, and that same buffer while it is being handed to
// userWorkers.create(). `inflight` only coalesces requests for the SAME function,
// so without this, N simultaneous cold requests for N DISTINCT functions each
// allocate their own 19-59MB buffer and nothing bounds the sum — five of the
// largest bundle in the image already exceed a 256Mi allowance. This makes
// eszipCacheMaxMb + eszipColdLoadHeadroomMb an enforced total rather than a
// documented hope, which is what the chart's budget assertion claims it is.
const COLD_LOAD_MAX_BYTES = byteBudget("EDGE_ESZIP_COLD_LOAD_MAX_BYTES", 256 * 1024 * 1024);
const inflight = new Map<string, Promise<Uint8Array | null>>();
const missing = new Set<string>();
const resident = new Map<string, Uint8Array>();
let residentBytes = 0;

const mb = (n: number) => (n / 1048576).toFixed(1);

// --- cold-load byte semaphore (FIFO) ---------------------------------------
// Held from before the read until userWorkers.create() has returned, because the
// buffer is referenced for that whole span.
//
// Strict FIFO, and the full byte size is charged:
//   * FIFO because waking every waiter does NOT prevent starvation. A large
//     request that still cannot fit re-queues, and a stream of small releases
//     lets younger small requests take the capacity ahead of it indefinitely.
//     Only the head of the queue may acquire, so nothing overtakes a blocked
//     older request.
//   * Full size, never clamped to the allowance, because Deno.readFile allocates
//     the whole bundle regardless of what the allowance says. Charging a clamped
//     value would let an oversized bundle through while accounting for less than
//     it actually costs, which is precisely the gap this semaphore exists to close.
//     A bundle larger than the entire allowance therefore runs ALONE (see
//     canAdmitCold), and eszipColdLoadHeadroomMb is required by the chart to be
//     large enough to cover the biggest bundle in the image.
let coldBytes = 0;
const coldQueue: Array<{ need: number; resolve: () => void }> = [];

function canAdmitCold(need: number): boolean {
  // A request bigger than the whole allowance could never satisfy the normal
  // condition, so it is allowed through when nothing else holds any bytes.
  if (need > COLD_LOAD_MAX_BYTES) return coldBytes === 0;
  return coldBytes + need <= COLD_LOAD_MAX_BYTES;
}

function pumpColdQueue(): void {
  while (coldQueue.length > 0 && canAdmitCold(coldQueue[0].need)) {
    const waiter = coldQueue.shift()!;
    coldBytes += waiter.need;
    waiter.resolve();
  }
}

async function acquireCold(size: number): Promise<void> {
  // Fast path only when nobody is queued — otherwise this would overtake them.
  if (coldQueue.length === 0 && canAdmitCold(size)) {
    coldBytes += size;
    return;
  }
  await new Promise<void>((resolve) => {
    coldQueue.push({ need: size, resolve });
    pumpColdQueue();
  });
}

function releaseCold(size: number): void {
  coldBytes -= size;
  pumpColdQueue();
}

// --- eviction pins -----------------------------------------------------------
// A resident buffer being handed to create() must not be evicted out from under
// that call: dropping it from `resident` would subtract its bytes from
// residentBytes while the reference is still live, so the accounting would claim
// memory that is still held. Pinned entries are skipped by eviction instead.
const pinned = new Map<string, number>();

function pin(name: string): void {
  pinned.set(name, (pinned.get(name) ?? 0) + 1);
}

function unpin(name: string): void {
  const n = (pinned.get(name) ?? 0) - 1;
  if (n > 0) pinned.set(name, n);
  else pinned.delete(name);
  // Reclaim anything that could not be evicted while this entry was in use.
  enforceBudget();
}

// Mark `name` most-recently-used. Map iterates in insertion order, so
// delete + re-set is the entire LRU.
function touch(name: string, bytes: Uint8Array): void {
  resident.delete(name);
  resident.set(name, bytes);
}

function admit(name: string, bytes: Uint8Array): void {
  // A single eszip larger than the whole budget is served but never cached;
  // admitting it would evict everything else to hold one entry.
  if (bytes.byteLength > ESZIP_CACHE_MAX_BYTES) return;
  // Re-admission shouldn't happen (`inflight` coalesces, and a hit returns
  // early), but double-counting here would silently raise the bound this whole
  // structure exists to enforce, so account for it rather than assume.
  const existing = resident.get(name);
  if (existing) residentBytes -= existing.byteLength;
  touch(name, bytes);
  residentBytes += bytes.byteLength;
  enforceBudget();
}

/**
 * Evict least-recently-used until residentBytes is back inside the budget.
 *
 * Pinned entries are skipped, which is what makes the pin safe — but it also
 * means a pass can end still over budget if every viable victim is in use. The
 * newly admitted entry is the most-recently-used, so it is the LAST thing this
 * loop considers: when pins leave no other room, the new entry is what gets
 * dropped, i.e. admission is refused rather than the bound being exceeded.
 * Serving is unaffected, since the caller already holds its own reference.
 *
 * unpin() calls this again, so bytes that could not be reclaimed while an entry
 * was in use are reclaimed as soon as it is released rather than staying resident
 * forever. Without that retry the "bounded" cache could ratchet upward, one
 * pinned admission at a time, past the total the chart's assertion certifies.
 */
function enforceBudget(): void {
  for (const victim of [...resident.keys()]) {
    if (residentBytes <= ESZIP_CACHE_MAX_BYTES) return;
    if (pinned.has(victim)) continue;
    const evicted = resident.get(victim)!;
    resident.delete(victim);
    residentBytes -= evicted.byteLength;
    eszipEvictions++;
    console.log(
      `[eszip] evicted ${victim} (${mb(evicted.byteLength)}MB), resident ` +
        `${mb(residentBytes)}MB / ${mb(ESZIP_CACHE_MAX_BYTES)}MB, ${resident.size} functions`
    );
  }
}

// === edge-tier metrics collector (pawtograder_edge_*) =======================
//
// THE INVARIANT THAT MATTERS, and it belongs directly under the eszip-leak note
// above because the contrast is the whole point.
//
// That leak was an unbounded `Map` in THIS isolate, keyed by function name, that
// a remote caller could grow by asking for functions it had never served. Its
// keys were function names too. What made it fatal was that its VALUES were
// 19-59MB buffers and its KEY SET was request-driven.
//
// `serviceName` is attacker-controlled in exactly the same way: the check at the
// top of the handler accepts any `^[a-zA-Z0-9_-]+$`, and `/functions/v1/*` is
// routed to this pod straight off the public internet by Kong. Keying a metrics
// map on it verbatim would rebuild that structure — an unbounded, remotely
// driven map in the pod-lifetime main isolate — and would additionally hand a
// remote caller a Prometheus cardinality bomb, since every distinct key becomes
// a distinct series on every one of the ~32 pods.
//
// So the key set is CLOSED AT BOOT. The two directories that define what this
// image can serve (the eszip bundles and the raw function dirs) are read once,
// synchronously, at startup into `FUNCTION_ALLOWLIST`. Anything not in that set
// records as function="_unknown". The label domain is therefore fixed at image
// BUILD time and no request can extend it. The values here are fixed-size
// numeric arrays plus a status map capped at STATUS_CAP entries, so the ceiling
// is ~56 x ~1.5KB ~= 85KB for the life of the pod, spent at boot.
//
// The same reasoning bounds `status`: it is derived from a Response status code
// rather than from input, but a broken worker could in principle produce many
// distinct values, so each function folds anything past STATUS_CAP into
// status="other".
//
// Because both label domains are closed and both alphabets are a subset of
// [a-zA-Z0-9_-], no Prometheus label-value escaping is needed anywhere below.
// Do not relax either bound without revisiting that.
//
// Everything is PER POD. Counters are summed correctly by Prometheus across
// pods; gauges describe this pod. Nothing is shared through Redis or any other
// store — a shared counter would be reported identically by all 32 pods and
// `sum(rate(...))` would over-count 32x.
//
// Gate: EDGE_METRICS (chart: edgeFunctions.metrics.enabled). Runtime env var,
// not a build-time constant, so it can be flipped by a values change.
const EDGE_METRICS = (Deno.env.get("EDGE_METRICS") ?? "0") !== "0";

// Latency histogram buckets, in seconds.
//
// NOT Prometheus' defaults (which top out at 10s). EDGE_WORKER_TIMEOUT_MS
// defaults to 400s, so default buckets would put this tier's entire tail in
// +Inf and every quantile above the median would be an extrapolation off the
// last finite bucket. le=400 is deliberately placed ON the worker lifetime, so
// "hit the worker timeout" reads as (+Inf - le=400) rather than smearing across
// the top bucket.
const DEFAULT_EDGE_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 400];

// Validated the way byteBudget() validates its inputs, and for the same reason:
// a bucket list that isn't finite and strictly increasing isn't a histogram.
// Non-monotonic bounds make the cumulative counts nonsensical and
// histogram_quantile() returns garbage rather than failing, so this rejects
// loudly and falls back rather than emitting a plausible-looking lie.
function histogramBuckets(envName: string, fallback: number[]): number[] {
  const raw = Deno.env.get(envName);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map(Number);
  const bad = (why: string) => {
    console.error(`${envName}=${JSON.stringify(raw)} ${why}; using ${fallback.join(",")}`);
    return fallback;
  };
  if (parsed.length === 0) return bad("has no bucket bounds");
  if (parsed.some((n) => !Number.isFinite(n) || n <= 0)) {
    return bad("contains a non-finite or non-positive bucket bound");
  }
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i] <= parsed[i - 1]) return bad("is not strictly increasing");
  }
  return parsed;
}

const EDGE_BUCKETS = histogramBuckets("EDGE_METRICS_BUCKETS", DEFAULT_EDGE_BUCKETS);

// Read once, synchronously, at boot. Sync is correct here: this runs before
// Deno.serve() accepts anything, and doing it lazily would reintroduce the
// request-driven growth the allowlist exists to prevent.
function bootFunctionAllowlist(): Set<string> {
  const names = new Set<string>();
  const add = (n: string) => {
    if (/^[a-zA-Z0-9_-]+$/.test(n)) names.add(n);
  };
  try {
    for (const e of Deno.readDirSync(ESZIP_DIR)) {
      if (e.isFile && e.name.endsWith(".eszip")) add(e.name.slice(0, -".eszip".length));
    }
  } catch (e) {
    console.error(`[edge-metrics] could not read ${ESZIP_DIR}:`, (e as Error)?.message ?? e);
  }
  try {
    // Raw function dirs are the servicePath fallback, so a function shipped
    // without a bundle is still a legitimate label value.
    for (const e of Deno.readDirSync("/home/deno/functions")) {
      if (e.isDirectory) add(e.name);
    }
  } catch (e) {
    console.error(`[edge-metrics] could not read /home/deno/functions:`, (e as Error)?.message ?? e);
  }
  return names;
}

const FUNCTION_ALLOWLIST: Set<string> = EDGE_METRICS ? bootFunctionAllowlist() : new Set<string>();
const UNKNOWN_FUNCTION = "_unknown";
const STATUS_CAP = 32;
const STATUS_OTHER = "other";

// Fixed-size per-function accumulator. Index into `nums`:
const N_SECONDS = 0; // pawtograder_edge_function_seconds_total
const N_ERR_RETIRED = 1; // worker_errors_total{kind="retired_retry"}
const N_ERR_CANCELLED = 2; // worker_errors_total{kind="cancelled"}
const N_ERR_INTERNAL = 3; // worker_errors_total{kind="internal"}
const N_FIELDS = 4;

type FnStats = { nums: Float64Array; statuses: Map<string, number> };

const fnStats = new Map<string, FnStats>();
if (EDGE_METRICS) {
  for (const name of [...FUNCTION_ALLOWLIST, UNKNOWN_FUNCTION]) {
    fnStats.set(name, { nums: new Float64Array(N_FIELDS), statuses: new Map() });
  }
  console.log(
    `[edge-metrics] enabled; ${FUNCTION_ALLOWLIST.size} allowlisted functions, ` +
      `${EDGE_BUCKETS.length} finite latency buckets (max ${EDGE_BUCKETS[EDGE_BUCKETS.length - 1]}s)`
  );
}

/** Map an arbitrary path segment onto the closed label domain. */
function metricsFunctionLabel(serviceName: string): string {
  return FUNCTION_ALLOWLIST.has(serviceName) ? serviceName : UNKNOWN_FUNCTION;
}

// Never allocates: every entry exists from boot, so a lookup either finds a
// pre-allocated accumulator or the collector is disabled and there is nothing to
// record. It deliberately does NOT create a missing entry -- that would be the
// request-driven growth the allowlist exists to prevent, reintroduced by a
// one-line convenience.
function statsFor(label: string): FnStats | undefined {
  return fnStats.get(label) ?? fnStats.get(UNKNOWN_FUNCTION);
}

// Pod-wide latency histogram. Deliberately has NO `function` label.
//
// DECIDED 2026-09-03: no per-function quantiles. Adding `function` here takes
// the edge tier from ~8.6k to ~37k series, all of them per-pod, so an HPA
// excursion to 64 replicas doubles the count at exactly the moment of load.
// Per-function COUNTS plus rate(function_seconds_total)/rate(requests_total)
// (mean latency, and share of total time spent) answer "which function is the
// problem" well enough. There is deliberately no flag for this.
const latencyCounts = new Float64Array(EDGE_BUCKETS.length + 1); // last slot = +Inf
let latencySum = 0;
let latencyCount = 0;

// eszip cache counters. These, plus the gauges below, directly instrument the
// two mechanisms that OOM-killed production: the resident cache and the
// cold-load buffers. container_memory_working_set_bytes cannot separate
// main-isolate heap from cache bytes from isolate heaps, so it can tell you the
// pod is growing but never which of the three is doing it.
let eszipHits = 0;
let eszipMisses = 0;
let eszipEvictions = 0;

/**
 * Record one completed request.
 *
 * `seconds` is TIME TO HEADERS, not full response time. worker.fetch() resolves
 * when the response HEADERS are ready; a streaming body finishes later.
 * Capturing end-of-body would need a per-request TransformStream wrapper around
 * the body, which allocates on the hot path and perturbs the stream
 * pass-through that the createWorker comment warns about. The `# HELP` string
 * says so explicitly so nobody reads this as end-to-end latency.
 */
function recordRequest(label: string, status: number, seconds: number): void {
  const s = statsFor(label);
  if (!s) return;
  s.nums[N_SECONDS] += seconds;

  const key = String(status);
  const existing = s.statuses.get(key);
  if (existing !== undefined) {
    s.statuses.set(key, existing + 1);
  } else if (s.statuses.size < STATUS_CAP) {
    s.statuses.set(key, 1);
  } else {
    // Second bound: a function that somehow produces more than STATUS_CAP
    // distinct codes folds the rest into one series rather than growing.
    s.statuses.set(STATUS_OTHER, (s.statuses.get(STATUS_OTHER) ?? 0) + 1);
  }

  // Linear scan over ~14 ascending bounds: allocation-free and faster than a
  // binary search at this length.
  let i = 0;
  while (i < EDGE_BUCKETS.length && seconds > EDGE_BUCKETS[i]) i++;
  latencyCounts[i]++;
  latencySum += seconds;
  latencyCount++;
}

function recordWorkerError(label: string, field: number): void {
  const s = statsFor(label);
  if (s) s.nums[field]++;
}

type RuntimeHeapStats = {
  usedHeapSize?: number;
  totalHeapSize?: number;
  externalMemory?: number;
};
type RuntimeMetrics = {
  mainWorkerHeapStats?: RuntimeHeapStats | null;
  activeUserWorkersCount?: number;
  retiredUserWorkersCount?: number;
  receivedRequestsCount?: number;
  handledRequestsCount?: number;
};

// Verified present on supabase/edge-runtime:v1.74.0 (the tag this image pins):
// EdgeRuntime exposes getRuntimeMetrics() and it is installed ONLY on the main
// worker, which is where this file runs. A user worker cannot call it, which is
// why these series cannot be produced by supabase/functions/metrics.
const RUNTIME_METRICS_TIMEOUT_MS = 1000;

/**
 * One await per scrape, with a hard timeout. A scrape must NEVER hang here: if
 * the runtime does not answer, the counters are still emitted and only the
 * runtime gauges are dropped for that scrape.
 */
async function runtimeMetrics(): Promise<RuntimeMetrics | null> {
  let timer: number | undefined;
  try {
    // @ts-expect-error EdgeRuntime is an untyped global provided by
    // supabase/edge-runtime, so this reference always errors under a plain
    // type-check -- which is what makes expect-error (rather than ignore) the
    // correct directive here.
    const fn = EdgeRuntime?.getRuntimeMetrics;
    if (typeof fn !== "function") return null;
    return await Promise.race([
      // @ts-expect-error same untyped global as above.
      EdgeRuntime.getRuntimeMetrics() as Promise<RuntimeMetrics>,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), RUNTIME_METRICS_TIMEOUT_MS);
      })
    ]);
  } catch (e) {
    console.error("[edge-metrics] getRuntimeMetrics failed:", (e as Error)?.message ?? e);
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Render this pod's exposition. Appended to the metrics user worker's body by
 * the /metrics interception in the handler below.
 *
 * All names live in the existing `pawtograder_*` namespace. They are
 * deliberately NOT the `deno_http_*` names the dashboard used to query:
 * asserting a producer that does not exist is what left that dashboard dark for
 * its whole life, and reusing the names would make the same claim again.
 */
async function renderEdgeMetrics(): Promise<string> {
  const out: string[] = [];
  const rt = await runtimeMetrics();

  out.push(
    "# HELP pawtograder_edge_requests_total Requests handled by the edge-functions demuxer, by function and response status. Per pod.",
    "# TYPE pawtograder_edge_requests_total counter",
    "# HELP pawtograder_edge_function_seconds_total Cumulative time-to-headers across requests, by function. Divide by requests_total for mean latency. Per pod.",
    "# TYPE pawtograder_edge_function_seconds_total counter",
    "# HELP pawtograder_edge_worker_errors_total User-worker failures in the demuxer, by function and kind (retired_retry|cancelled|internal). Per pod.",
    "# TYPE pawtograder_edge_worker_errors_total counter"
  );
  for (const [name, s] of fnStats) {
    for (const [status, n] of s.statuses) {
      out.push(`pawtograder_edge_requests_total{function="${name}",status="${status}"} ${n}`);
    }
    if (s.nums[N_SECONDS] > 0) {
      out.push(`pawtograder_edge_function_seconds_total{function="${name}"} ${s.nums[N_SECONDS]}`);
    }
    const kinds: Array<[string, number]> = [
      ["retired_retry", s.nums[N_ERR_RETIRED]],
      ["cancelled", s.nums[N_ERR_CANCELLED]],
      ["internal", s.nums[N_ERR_INTERNAL]]
    ];
    for (const [kind, n] of kinds) {
      if (n > 0) out.push(`pawtograder_edge_worker_errors_total{function="${name}",kind="${kind}"} ${n}`);
    }
  }

  out.push(
    "# HELP pawtograder_edge_request_duration_seconds Demuxer TIME TO HEADERS (worker.fetch resolution), not full response time -- a streaming body finishes later. Pod-wide: deliberately has no function label, see the note in main.ts.",
    "# TYPE pawtograder_edge_request_duration_seconds histogram"
  );
  let cumulative = 0;
  for (let i = 0; i < EDGE_BUCKETS.length; i++) {
    cumulative += latencyCounts[i];
    out.push(`pawtograder_edge_request_duration_seconds_bucket{le="${EDGE_BUCKETS[i]}"} ${cumulative}`);
  }
  cumulative += latencyCounts[EDGE_BUCKETS.length];
  out.push(
    `pawtograder_edge_request_duration_seconds_bucket{le="+Inf"} ${cumulative}`,
    `pawtograder_edge_request_duration_seconds_sum ${latencySum}`,
    `pawtograder_edge_request_duration_seconds_count ${latencyCount}`
  );

  out.push(
    "# HELP pawtograder_edge_eszip_cache_bytes Resident eszip bundle bytes held by this pod's demuxer (the LRU that OOM-killed prod on 2026-08-19).",
    "# TYPE pawtograder_edge_eszip_cache_bytes gauge",
    `pawtograder_edge_eszip_cache_bytes ${residentBytes}`,
    "# HELP pawtograder_edge_eszip_cache_entries Functions currently resident in this pod's eszip cache.",
    "# TYPE pawtograder_edge_eszip_cache_entries gauge",
    `pawtograder_edge_eszip_cache_entries ${resident.size}`,
    "# HELP pawtograder_edge_eszip_cold_bytes Bundle bytes reserved against the cold-load semaphore right now (cache misses in flight).",
    "# TYPE pawtograder_edge_eszip_cold_bytes gauge",
    `pawtograder_edge_eszip_cold_bytes ${coldBytes}`,
    "# HELP pawtograder_edge_eszip_cold_queue_depth Cold loads waiting for cold-load budget. Sustained non-zero means the headroom is undersized.",
    "# TYPE pawtograder_edge_eszip_cold_queue_depth gauge",
    `pawtograder_edge_eszip_cold_queue_depth ${coldQueue.length}`,
    "# HELP pawtograder_edge_eszip_cache_hits_total Bundle reads served from the resident cache.",
    "# TYPE pawtograder_edge_eszip_cache_hits_total counter",
    `pawtograder_edge_eszip_cache_hits_total ${eszipHits}`,
    "# HELP pawtograder_edge_eszip_cache_misses_total Bundle reads that went to disk. Excludes negative-cache lookups (no bundle exists), which are neither a hit nor a miss.",
    "# TYPE pawtograder_edge_eszip_cache_misses_total counter",
    `pawtograder_edge_eszip_cache_misses_total ${eszipMisses}`,
    "# HELP pawtograder_edge_eszip_cache_evictions_total Entries evicted by the byte-budget LRU.",
    "# TYPE pawtograder_edge_eszip_cache_evictions_total counter",
    `pawtograder_edge_eszip_cache_evictions_total ${eszipEvictions}`
  );

  if (rt) {
    const heap = rt.mainWorkerHeapStats ?? null;
    if (typeof rt.activeUserWorkersCount === "number") {
      out.push(
        "# HELP pawtograder_edge_user_workers_active User worker isolates alive on this pod right now.",
        "# TYPE pawtograder_edge_user_workers_active gauge",
        `pawtograder_edge_user_workers_active ${rt.activeUserWorkersCount}`
      );
    }
    if (typeof rt.retiredUserWorkersCount === "number") {
      out.push(
        "# HELP pawtograder_edge_user_workers_retired_total User worker isolates retired by the runtime on this pod (memory / CPU / wall-clock limit).",
        "# TYPE pawtograder_edge_user_workers_retired_total counter",
        `pawtograder_edge_user_workers_retired_total ${rt.retiredUserWorkersCount}`
      );
    }
    if (typeof rt.receivedRequestsCount === "number") {
      out.push(
        "# HELP pawtograder_edge_requests_received_total Requests the runtime accepted on this pod.",
        "# TYPE pawtograder_edge_requests_received_total counter",
        `pawtograder_edge_requests_received_total ${rt.receivedRequestsCount}`
      );
    }
    if (typeof rt.handledRequestsCount === "number") {
      out.push(
        "# HELP pawtograder_edge_requests_handled_total Requests the runtime finished handling on this pod. received - handled is in-flight plus dropped.",
        "# TYPE pawtograder_edge_requests_handled_total counter",
        `pawtograder_edge_requests_handled_total ${rt.handledRequestsCount}`
      );
    }
    if (heap) {
      const stats: Array<[string, number | undefined]> = [
        ["used", heap.usedHeapSize],
        ["total", heap.totalHeapSize],
        ["external", heap.externalMemory]
      ];
      const emitted = stats.filter(([, v]) => typeof v === "number");
      if (emitted.length > 0) {
        out.push(
          "# HELP pawtograder_edge_main_worker_heap_bytes V8 heap of the pod-lifetime MAIN isolate (this demuxer). Subtract this and eszip_cache_bytes from the container working set to isolate user-worker memory.",
          "# TYPE pawtograder_edge_main_worker_heap_bytes gauge"
        );
        for (const [stat, v] of emitted) {
          out.push(`pawtograder_edge_main_worker_heap_bytes{stat="${stat}"} ${v}`);
        }
      }
    }
  }

  return out.join("\n") + "\n";
}

// Snapshot the process env ONCE at startup. It's static for the lifetime of the
// pod, and this runs on the gateway hot path — recomputing it per request would
// churn allocations needlessly. Workers created below all receive this same array.
const envVars = Object.entries(Deno.env.toObject()) as [string, string][];

/**
 * Run `runWithBundle` with this function's bundle, holding the bundle's bytes against a
 * budget for exactly as long as the reference is live.
 *
 * Two cases, deliberately different:
 *   * Cache HIT — the bytes are already counted in residentBytes, so no extra
 *     reservation is taken. The entry is pinned instead, so eviction cannot
 *     subtract its bytes while the reference is still held.
 *   * Cache MISS — the bytes are not in the cache budget (and may never be, if
 *     admit() refuses them as oversized or eviction drops them again), so they are
 *     reserved against COLD_LOAD_MAX_BYTES for the whole span. `stat` gives the
 *     size before the allocation happens, which is the only way to reserve BEFORE
 *     the memory is spent rather than after.
 *
 * Concurrent misses for the same name each reserve, which over-reserves for one
 * shared buffer. That errs toward waiting rather than toward exceeding the budget,
 * which is the direction to err in.
 */
async function withEszip<T>(
  name: string,
  runWithBundle: (eszip: Uint8Array | null) => Promise<T>
): Promise<T> {
  if (resident.has(name)) {
    pin(name);
    try {
      return await runWithBundle(await loadEszip(name));
    } finally {
      unpin(name);
    }
  }

  if (missing.has(name)) return await runWithBundle(null);

  let size = 0;
  try {
    size = (await Deno.stat(`${ESZIP_DIR}/${name}.eszip`)).size;
  } catch {
    // No bundle (or unreadable): loadEszip records the negative result and the
    // caller falls back to the raw servicePath. Nothing to reserve.
    return await runWithBundle(await loadEszip(name));
  }

  await acquireCold(size);
  try {
    return await runWithBundle(await loadEszip(name));
  } finally {
    releaseCold(size);
  }
}

function loadEszip(name: string): Promise<Uint8Array | null> {
  const hit = resident.get(name);
  if (hit) {
    touch(name, hit);
    eszipHits++;
    return Promise.resolve(hit);
  }
  // The negative-cache path is counted as NEITHER a hit nor a miss: there is no
  // bundle for this function at all, so it is not a caching outcome. That is why
  // hits + misses does not equal bundle lookups; see the _misses_total HELP.
  if (missing.has(name)) return Promise.resolve(null);

  let pending = inflight.get(name);
  if (!pending) {
    eszipMisses++;
    pending = Deno.readFile(`${ESZIP_DIR}/${name}.eszip`)
      .then((bytes): Uint8Array | null => {
        admit(name, bytes);
        return bytes;
      })
      .catch((e) => {
        if (e instanceof Deno.errors.NotFound) {
          missing.add(name);
        } else {
          // Transient — deliberately NOT remembered, so the next request retries.
          console.error(`failed to read eszip for ${name}:`, (e as Error)?.message ?? e);
        }
        return null;
      })
      .finally(() => {
        inflight.delete(name);
      });
    inflight.set(name, pending);
  }
  return pending;
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);
  const serviceName = pathParts[0];

  if (!serviceName) {
    return new Response(JSON.stringify({ msg: "missing function name in request path" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // Reject anything that isn't a plain function-directory name (e.g. ".." or
  // "foo/bar"). All real pawtograder functions match this pattern; rejecting
  // the rest prevents path traversal under /home/deno/functions and the
  // eszip dir.
  if (!/^[a-zA-Z0-9_-]+$/.test(serviceName)) {
    return new Response(JSON.stringify({ msg: "invalid function name" }), {
      status: 400,
      headers: { "content-type": "application/json" }
    });
  }

  // Collapse anything outside the boot-time allowlist to "_unknown" ONCE, here,
  // so no code path below can key state on the raw (attacker-controlled) segment.
  // Unconditional, not gated: the raw segment must never be carried in a
  // variable the recording functions can key on. With the collector off the
  // allowlist is empty, so this is always "_unknown" and nothing records anyway.
  const functionLabel = metricsFunctionLabel(serviceName);

  // The Prometheus scrape. Routed to the `metrics` user worker exactly like any
  // other function -- the request object is not touched, because reconstructing
  // it breaks functions that rely on its underlying stream resource and `metrics`
  // is named in that warning below. Only the RESPONSE is modified.
  const isMetricsScrape = serviceName === "metrics" && url.pathname === "/metrics" && req.method === "GET";

  const servicePath = `/home/deno/functions/${serviceName}`;

  const createWorker = () =>
    withEszip(serviceName, async (eszip) => {
      // The bundle is obtained and accounted for by withEszip, which holds it
      // against a budget for exactly as long as this reference is live and
      // releases it when create() returns.
      //
      // It used to be loaded once per request above callWorker, so the closure
      // held a 19-59MB buffer for as long as worker.fetch() ran — up to the 400s
      // worker lifetime. Narrowing it to create() shrank that window; withEszip
      // is what actually bounds the sum across concurrent cold loads for
      // DIFFERENT functions, which coalescing on `inflight` never could.
      const opts: Record<string, unknown> = {
      servicePath,
      memoryLimitMb: MEMORY_LIMIT_MB,
      lowMemoryMultiplier: LOW_MEMORY_MULTIPLIER,
      workerTimeoutMs: WORKER_TIMEOUT_MS,
      cpuTimeSoftLimitMs: CPU_SOFT_MS,
      cpuTimeHardLimitMs: CPU_HARD_MS,
      noModuleCache: false,
      importMapPath: null,
      // Tell the isolate which function it's serving so its own logs can be
      // tagged (see _shared/HandlerUtils.ts). Passed as an env var rather than a
      // request header so the request object handed to worker.fetch() is left
      // completely untouched — reconstructing the Request breaks functions that
      // rely on its underlying stream resource (e.g. `metrics`). Safe because
      // the worker is created against this function's servicePath, so it only
      // ever serves `serviceName`.
      envVars: [...envVars, ["EDGE_FUNCTION_NAME", serviceName] as [string, string]]
    };
    if (eszip) {
      // Pre-bundled path: load the vendored, pre-transpiled module graph from
      // the eszip. The entrypoint key matches how the bundle was built in the
      // Dockerfile (--entrypoint /home/deno/functions/<name>/index.ts).
      opts.maybeEszip = eszip;
      opts.maybeEntrypoint = `file:///home/deno/functions/${serviceName}/index.ts`;
    }
      // @ts-expect-error EdgeRuntime is an untyped global provided by
      // supabase/edge-runtime, so this reference always errors under a plain
      // type-check -- which is what makes expect-error (rather than ignore) the
      // correct directive here.
      return await EdgeRuntime.userWorkers.create(opts);
    });

  // Reuse the pooled worker for this function; on retirement, route to a fresh
  // one (create() won't hand back a retired worker). Mirrors the stock
  // callWorker() retry loop.
  const callWorker = async (attempt = 0): Promise<Response> => {
    try {
      const worker = await createWorker();
      return await worker.fetch(req);
    } catch (e) {
      const name = (e as { name?: string })?.name ?? "";
      const msg = (e as Error)?.message ?? String(e);

      // Worker was retired (memory / CPU / wall-clock limit) before it could
      // serve this request — retry on a fresh worker rather than failing.
      if ((name === "WorkerAlreadyRetired" || /retired/i.test(msg)) && attempt < MAX_RETIRED_RETRIES) {
        if (EDGE_METRICS) recordWorkerError(functionLabel, N_ERR_RETIRED);
        return await callWorker(attempt + 1);
      }

      // Worker died mid-request (supervisor hit a hard limit). The request is
      // unrecoverable here; surface 503 + Connection: close so the caller
      // (pg_net / cron / client) retries on its own cadence instead of us
      // hammering a fresh worker with the same expensive request.
      if (name === "WorkerRequestCancelled" || /cancel{1,2}ed/i.test(msg)) {
        if (EDGE_METRICS) recordWorkerError(functionLabel, N_ERR_CANCELLED);
        return new Response(JSON.stringify({ msg: "worker request cancelled" }), {
          status: 503,
          headers: { "content-type": "application/json", "Connection": "close" }
        });
      }

      // Log the real error server-side, but return a fixed generic message — the
      // raw error can carry worker/runtime internals (paths, stack frames) and
      // this gateway is public-facing (CodeQL: information exposure via stack trace).
      if (EDGE_METRICS) recordWorkerError(functionLabel, N_ERR_INTERNAL);
      console.error(`[fn=${serviceName}] error invoking ${serviceName}:`, e);
      return new Response(JSON.stringify({ msg: "internal edge function error" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  };

  const startedAt = Date.now();
  const res = await callWorker();
  // Reuses the SAME Date.now() the access log already needs -- there is no second
  // clock read on the hot path.
  const elapsedMs = Date.now() - startedAt;
  if (ACCESS_LOG) {
    console.log(`[fn=${serviceName}] ${req.method} ${url.pathname} -> ${res.status} ${elapsedMs}ms`);
  }
  // The scrape itself is NOT traffic. Every ServiceMonitor poll routes through
  // serviceName="metrics" like any other function, so recording it here made the
  // monitoring system its own busiest client: 32 pods on a 30s interval is
  // ~1.07 RPS of synthetic requests, plus latency samples in the pod-wide
  // histogram, plus a steady stream of guaranteed 200s that dilute the
  // fleet-wide 5xx ratio on the `edge-functions` dashboard -- worst during quiet
  // periods, which is exactly when that ratio should be most sensitive. The web
  // tier already excludes /api/metrics from web_http_* (lib/routeMetrics.ts
  // is not applied to that route); this is the same rule.
  //
  // Worker errors are still recorded for the scrape path (see callWorker above),
  // deliberately. Those are not synthetic-success dilution -- a metrics function
  // that is failing to start is exactly what you want visible, and it is the one
  // failure that also blanks this pod's own exposition.
  if (EDGE_METRICS && !isMetricsScrape) {
    recordRequest(functionLabel, res.status, elapsedMs / 1000);
  }

  // /metrics demux: append this pod's exposition to the metrics function's own.
  //
  // Appending ONLY on a 200 is what makes the credential check inherited rather
  // than duplicated. METRICS_TOKEN is enforced inside the user worker
  // (supabase/functions/metrics/index.ts), so an unauthorized scrape gets its
  // 401 back with nothing added and this demuxer never sees the token at all.
  //
  // It also preserves the 500 path deliberately. The metrics function returns
  // 500 when its first DB RPC fails, and prometheus-rules.yaml documents
  // PawtograderPostgresUnavailable as existing BECAUSE of that. Turning this
  // into a partial 200 would silently weaken a paging alert. The accepted cost:
  // when Postgres is wedged the pawtograder_edge_* series go dark too, even
  // though they need no database. That is the right trade -- the page fires.
  if (EDGE_METRICS && isMetricsScrape && res.status === 200) {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/plain")) {
      // Rendered BEFORE the body is consumed, so a throw here leaves `res`
      // untouched and passes it straight through. The queues-and-workers
      // dashboard reads off this same response and must not be breakable by
      // anything added in this file.
      let appended: string | null = null;
      try {
        appended = await renderEdgeMetrics();
      } catch (e) {
        console.error("[edge-metrics] render failed, passing worker response through:", e);
      }
      if (appended !== null) {
        try {
          const body = await res.text();
          const headers = new Headers(res.headers);
          // The body length changed; a stale content-length would truncate it.
          headers.delete("content-length");
          return new Response(body + appended, { status: res.status, statusText: res.statusText, headers });
        } catch (e) {
          console.error("[edge-metrics] could not read worker response body:", e);
          return res;
        }
      }
    }
  }
  return res;
});
