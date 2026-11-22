# Connection Runtime

> For maintainers. Using d4research? See [docs/user](../user/).

Web and mobile share one connection runtime that owns connectivity,
authentication, retries, transport lifetime, cached environment data, and
environment-scoped operations.

Web and mobile mount this runtime once at the application root and compose it
identically: `apps/web/src/connection/runtime.ts` and
`apps/mobile/src/connection/runtime.ts` differ only in the platform layer they
supply. There is no legacy connection owner or supported mixed mode.

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with jittered exponential backoff, capped at
five minutes, that resets only after a connection stays up. Without jitter, every
client of a restarted server reconnects in the same second; with a short cap, a
client that can never connect retries all day. Offline states and authentication
failures wait for a wakeup instead of spending attempts on unchanged conditions.

Foregrounding, a network change, an explicit retry, and an offline report probe
the established session, and only a failed probe reconnects. Offline reports are
often wrong, for example for a loopback server. The OS can kill a suspended
socket without a close event, so a probe still unanswered after 500 ms asks the
host for its public descriptor over a fresh request, again each second until it
answers. If the host answers while the socket delivers no frame, the socket is
dead and is replaced, even while the network reports offline: at once on
loopback and LAN, and 2.5 seconds after the check starts elsewhere, where one
lost packet can stall a live socket. Without that evidence the probe deadline
decides: 3 seconds on loopback and LAN routes and after a long mobile
suspension, when the data on screen is stale; 15 seconds elsewhere, because a
tailnet over DERP or a VPN can be slower than that on a live socket. A long
suspension's probe that times out also replaces the socket regardless of the
network report. The web and desktop foreground probe skips the fresh request,
because a busy host can answer it before a queued probe. Foregrounding also
wakes a pending retry immediately. A long suspension restarts an in-flight
attempt; a short one leaves it alone.

## Composition

[`connection/layer.ts`][layer] assembles the runtime:

- `ConnectionResolver` ([resolver.ts][resolver]) resolves a catalog entry into a
  prepared, authenticated endpoint for primary, bearer, or SSH targets.
- `ConnectionDriver` ([driver.ts][driver]) prepares through the resolver, opens
  one RPC session, and reports `preparing`, `opening`, and `synchronizing`.
- `RpcSessionFactory` ([rpc/session.ts][session]) performs one transport
  attempt. It does not retry. `RpcSession` is the interface it returns,
  exposing `client`, `initialConfig`, `ready`, `probe`, and `closed`.
- `EnvironmentRegistry` ([registry.ts][registry]) owns the catalog and the
  per-environment scopes.
- `ConnectionOnboarding` sits alongside the registry. Startup calls
  `EnvironmentRegistry.start` and streams platform registrations into
  `reconcilePlatform`.

The registry creates one environment-scoped supervisor per environment.
`acquireSupervisor` serializes access per environment; it reuses an existing
supervisor if the catalog entry is unchanged and closes then recreates the scope
if it changed. `createServiceScope` builds an `EnvironmentSupervisor` bound to a
closeable scope and connects it. `run` and `runStream` execute caller effects
with that supervisor provided.

`EnvironmentSupervisor` owns desired state, retry scheduling, and the active
session scope. React components do not create connections, transports, retry
loops, or RPC clients.

## Connection State

The supervisor is the only retry owner.

1. A persisted or platform registration marks an environment as desired.
2. If the device is offline, the supervisor releases the active session and
   waits for a signal without consuming retry attempts or running a timer.
3. When online, it asks the driver for one prepared connection and one RPC
   session.
4. Transient failures retry forever with jittered exponential backoff capped at
   five minutes (`RETRY_MAX_DELAY_MS`). A connection stable for 30 seconds
   (`BACKOFF_RESET_AFTER_MS`) resets accumulated backoff.
5. Authentication or configuration failures remain blocked until an external
   wakeup changes the relevant input.
6. An involuntary session close keeps the registration and cache, then retries.
7. Explicit removal closes the session and deletes the registration,
   credentials, shell cache, and thread cache.

The shell snapshot loads over HTTP, which needs only the prepared connection, so
the [shell state](../../packages/client-runtime/src/state/shell.ts) can ask for
it before the socket and the config are ready. Two constraints follow. The live
config stays the authority: rows loaded early for a build or with omissions that
it does not confirm are replaced, never resumed. And an HTTP answer must never
land on rows the socket has moved on: the subscription waits for the answer, and
when held rows can resume, it ends the request 3 seconds after the socket is
ready. A proxy that drops `/api` without an answer then does not hold the
connect for the HTTP timeout.

Each environment synchronizes at its own time, so a thread list that follows every
snapshot moves once per environment on each cold start and resume. Mobile lists read
[steady shells](../../packages/client-runtime/src/state/steadyShells.ts): an
environment's rows stay as shown until its connection's server snapshot arrives,
it is synchronized, or it disconnects, and environments that get there within two
seconds of each other show together. Only an environment that is connected or on
its first attempt, and still owes its snapshot, is waited for; a retry can take
minutes. A move in a list is refused while its rows wait, because its plan would
use order keys the server may have replaced. Every other row action looks up the
live row before it reads thread state, so an undo plan or a guard never uses a held
row. The hold stops only changes the user
did not cause: a command that moves or removes a row (settle, snooze, pin, archive,
delete, and their reverses) makes that environment's rows follow the live snapshot
until it is live. Point reads (a
thread's own shell, route checks) keep the live snapshot, where a row the server just
sent must not look missing. The decision reads the snapshot's own sequence: a second
atom derived from the same shell state can be one update behind the rows. The mobile
splash screen also waits, for a bounded time, until every enabled environment has
read its cached shell and Home's list has laid out those rows, so the first frame
holds all cached rows.

Shell snapshots can leave rows out when the client asks. Servers that advertise
`shellThreadFamilies` leave out idle subagent children: a child stays while it
has a live or queued run, a pending request or background work, or a subagent
child of its own, so badge and working walks never meet a gap. Servers that also
advertise `shellOlderSettled` keep only the 25 newest settled top-level threads
(and any tied with the 25th, pinned, snoozed, live, or above a kept child); the
snapshot's `olderSettled` names that cut and counts the rest per project. Left-out
rows load on demand and merge behind shell rows
([thread families](../../packages/client-runtime/src/state/threadFamilies.ts)):
the family a thread view or a queued message mounts holds every active thread
sharing the thread's root, so it also brings back an old settled thread opened by
link; the Settled shelf reads pages below the cut; searches return the rows of
older matches. A missing shell row therefore does not prove a thread is gone:
code that deletes data or a worktree on absence must check the family or the
server first.

### Wakeups

Wakeup handling differs by phase, in [supervisor.ts][supervisor]:

- During establishment, `waitForEstablishmentInterrupt` consumes and **ignores**
  plain application activation. Restarting an in-flight attempt because the app
  came to the foreground would only delay it. The exception is
  `application-active-reconnect`, which mobile emits after a meaningful
  background suspension; it interrupts establishment and resets the retry
  ladder, because the OS may have silently killed the socket underneath the
  attempt.
- Explicit disconnect, explicit retry, and going offline interrupt establishment
  in every case.
- While waiting out backoff, application activation resets the retry ladder so a
  foregrounded app reconnects immediately instead of serving the remaining
  delay.
- Once connected, `monitorConnectedLease` handles plain activation by probing
  the existing session (`lease.session.probe`, with a shorter timeout for
  mobile's `application-active-probe`) rather than reconnecting; a healthy
  session survives foregrounding. `application-active-reconnect` skips the probe
  and replaces the lease outright.

The UI derives `available`, `offline`, `connecting`, `reconnecting`,
`connected`, and `error` from supervisor state plus explicit data-sync state.
It does not infer connection health from cached data or the existence of a
transport object. An environment becomes `connected` after the socket opens and
the initial config RPC succeeds, proving that the server is responsive. Shell
and thread synchronization are independent data states. A healthy RPC transport
with a failed shell subscription is shown as connected with a synchronization
error, not as a reconnect that is not actually scheduled.

## Data Boundary

Finite requests, durable subscriptions, and commands are separate APIs:

- Query atoms revalidate when the RPC generation changes.
- Subscription atoms switch to replacement sessions.
- Subscription failure handling in [rpc/client.ts][client] distinguishes two
  cases. A transport failure (`isTransportFailure`: every failure is an RPC
  client error) ends the inner subscription without resubscribing, so the outer
  stream waits for the supervisor to supply a replacement session. A handled
  domain failure runs `onExpectedFailure` and, when
  `retryExpectedFailureAfter` is set, sleeps and resubscribes on the **same**
  session. A healthy transport is never torn down for a domain failure.
- Mutations resolve the current environment runtime at execution time.
- Shell and thread snapshots are available while offline.
- On desktop, a [keep-alive](../../apps/web/src/state/threads.ts) mounts every
  thread whose session is starting or running, in each enabled environment, so
  opening a running thread needs no replay. The shell and detail streams are
  independent, so the shell can report a stop before the detail catches up. A
  stopped thread stays mounted until its own stream is live and shows the stop,
  then the stream closes and saves the settled state. Web and mobile do not keep
  threads alive.
- Sync status is explicit and independent per domain. Shell status is `empty`,
  `cached`, `synchronizing`, or `live`, with a separate `error` field; there is
  no `failed` status. Thread status adds `deleted`.
- Cached shell and thread projections are never allowed to overwrite newer live
  data during a fast reconnect.
- Domain atom factories route effects through the environment registry and
  resolve the current scoped service at execution time. Project and thread
  commands are Atom factories under `src/state`
  (`createProjectEnvironmentAtoms`, `createThreadEnvironmentAtoms`), as are the
  shell and thread state factories (`createEnvironmentShellAtoms`,
  `createEnvironmentThreadStateAtoms`).
- Web and mobile own their Atom runtimes, React hooks, and feature composition.

The Promise bridge exists only at the React/Atom boundary. Runtime and business
logic remain Effect-native.

## Platform Layers

Web and mobile provide:

- network status and network-change streams;
- application lifecycle wakeups;
- platform registrations;
- persistent catalog, credential, shell, and thread stores;
- HTTP and telemetry layers.

Platform layers adapt operating-system capabilities, but they do not implement
connection policy. `EnvironmentOwnedDataCleanup` is part of this contract: on
removal, the registry clears its cache and calls the platform implementation so
web clears composer drafts and mobile clears drafts plus the thread outbox.

## Source Boundaries

Applications must import explicit package subpaths; the package intentionally
has no root export. The subpaths are documented in
[packages/client-runtime/README.md](../../packages/client-runtime/README.md),
with the `exports` map in that package's `package.json` as the authoritative
list. Files that are not exported are implementation details.

## Application Boundary

The application root mounts the shared connection layer, creates its own Atom
runtime, and selects the domain atom factories required by that platform. Web
and mobile may expose different hooks and features without changing connection
ownership.

Application code must not construct RPC clients, retry loops, or raw
orchestration commands. Persistence paths belong to the platform registration
and cache stores, with explicit migration or invalidation policy.

## Verification

Core state-machine tests use `@effect/vitest` and deterministic service layers.
Required coverage includes:

- offline startup and online wakeup;
- forever retry with the 16-second cap;
- explicit retry interrupting backoff;
- authentication wakeups;
- involuntary close and reconnect;
- explicit removal clearing all owned state;
- shell and thread cache hydration;
- durable subscriptions switching sessions;
- command metadata and idempotent queued-command metadata.

[layer]: ../../packages/client-runtime/src/connection/layer.ts
[resolver]: ../../packages/client-runtime/src/connection/resolver.ts
[driver]: ../../packages/client-runtime/src/connection/driver.ts
[registry]: ../../packages/client-runtime/src/connection/registry.ts
[supervisor]: ../../packages/client-runtime/src/connection/supervisor.ts
[session]: ../../packages/client-runtime/src/rpc/session.ts
[client]: ../../packages/client-runtime/src/rpc/client.ts
