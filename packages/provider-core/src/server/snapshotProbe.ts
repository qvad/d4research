import type {
  CustomModelSetting,
  ProviderDriverKind,
  ModelCapabilities,
  RuntimeMode,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderUsage,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderUpdateRequiredModel,
  ServerProviderState,
} from "@d4research/contracts";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { readCustomModelEntries } from "@d4research/shared/model";
import * as HostProcess from "@d4research/shared/HostProcess";
import { createProviderVersionAdvisory } from "./maintenanceResolver.ts";
import { collectUint8StreamText } from "./collectStreamText.ts";

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

export const isWindowsCommandNotFound = Effect.fn("isWindowsCommandNotFound")(function* (
  code: number | null,
  stderr: string,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") return false;
  if (code === 9009) return true;
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr));
});

export const DEFAULT_TIMEOUT_MS = 4_000;
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export const resolveProviderProbeTimeoutMs = (
  provider: string,
  defaultTimeoutMs: number,
  environment: NodeJS.ProcessEnv = process.env,
): number => {
  const timeoutMs = Number(environment[`T3CODE_${provider.toUpperCase()}_PROBE_TIMEOUT_MS`]);
  // Overrides only extend: callers nest these deadlines and size optional work inside them
  // against the defaults. Node timers overflow above a signed 32-bit delay.
  return Number.isInteger(timeoutMs) && timeoutMs > defaultTimeoutMs && timeoutMs <= 2_147_483_647
    ? timeoutMs
    : defaultTimeoutMs;
};

export const COMPACT_SLASH_COMMAND = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
} satisfies ServerProviderSlashCommand;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export class ProviderCommandNotFoundError extends Schema.TaggedError<ProviderCommandNotFoundError>()(
  "ProviderCommandNotFoundError",
  {
    binaryPath: Schema.String,
    exitCode: Schema.Number,
    stdoutLength: Schema.Number,
    stderrLength: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider command ${this.binaryPath} was not found (exit code ${this.exitCode}).`;
  }
}

const isProviderCommandNotFoundError = Schema.is(ProviderCommandNotFoundError);

export class ProviderProbeOutputLimitError extends Schema.TaggedError<
  ProviderProbeOutputLimitError,
  { readonly brand: unique symbol }
>()("ProviderProbeOutputLimitError", {
  stream: Schema.Literals(["stdout", "stderr"]),
  maxBytes: Schema.Number,
}) {
  override get message(): string {
    return `Provider status check produced too much ${this.stream} (limit ${this.maxBytes} bytes). Check the configured executable or wrapper in this environment's terminal.`;
  }
}

export interface ProviderProbeResult {
  readonly usageLimits?: ServerProvider["usageLimits"];
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

function providerReadiness(input: {
  readonly enabled: boolean;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly probe: ProviderProbeResult;
}) {
  const installation = !input.enabled
    ? ("disabled" as const)
    : input.probe.installed
      ? ("ready" as const)
      : ("missing" as const);
  const authentication =
    input.probe.auth.status === "authenticated"
      ? ("ready" as const)
      : input.probe.auth.status === "unauthenticated"
        ? ("required" as const)
        : ("unknown" as const);
  const reachability =
    input.enabled && input.probe.installed && input.probe.status === "ready"
      ? ("ready" as const)
      : input.probe.status === "error"
        ? ("failed" as const)
        : ("unknown" as const);
  const modelCatalog =
    input.models.length === 0
      ? ("missing" as const)
      : reachability === "ready"
        ? ("ready" as const)
        : ("unknown" as const);
  const canStart =
    installation === "ready" &&
    authentication !== "required" &&
    reachability === "ready" &&
    modelCatalog === "ready";
  const remediation = canStart
    ? undefined
    : !input.enabled
      ? "Enable this provider in Settings → Providers."
      : !input.probe.installed
        ? (input.probe.message ?? "Install the provider CLI and refresh its status.")
        : authentication === "required"
          ? (input.probe.message ?? "Authenticate the provider CLI, then refresh its status.")
          : modelCatalog === "missing"
            ? "No usable models were discovered. Check the provider endpoint and credentials, then refresh."
            : (input.probe.message ?? "The provider probe did not confirm a usable connection.");
  return {
    installation,
    authentication,
    reachability,
    modelCatalog,
    canStart,
    checkedAt: input.checkedAt,
    ...(remediation ? { remediation } : {}),
  };
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
  readonly reportsContextWindow?: boolean;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly supportsConversationRollback?: boolean;
}

export type ServerProviderDraft = Omit<ServerProvider, "instanceId" | "driver">;

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: unknown): boolean {
  if (isProviderCommandNotFoundError(error)) return true;
  return error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound";
}

/**
 * Environment for background status probes. A mise shim for a missing tool would otherwise
 * download it on every refresh and leave a partial download behind when the probe times out.
 * Sessions and user-started commands keep the plain environment, so mise still installs there.
 */
export function providerProbeEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, MISE_OFFLINE: "1" };
}

// A timed-out probe interrupts the child with SIGTERM and then waits for it to exit,
// so a CLI that ignores SIGTERM would hold the caller's timeout open without this.
const PROBE_FORCE_KILL_AFTER = "1 second";
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024 * 1024;

function withProbeForceKill(command: ChildProcess.Command): ChildProcess.Command {
  if (!ChildProcess.isStandardCommand(command) || command.options.forceKillAfter !== undefined) {
    return command;
  }
  return ChildProcess.make(command.command, command.args, {
    ...command.options,
    forceKillAfter: PROBE_FORCE_KILL_AFTER,
  });
}

export const spawnAndCollect = Effect.fn("snapshotProbe.spawnAndCollect")(function* (
  binaryPath: string,
  command: ChildProcess.Command,
  options?: { readonly maxStdoutBytes: number },
) {
  const maxStdoutBytes = options?.maxStdoutBytes ?? MAX_PROBE_OUTPUT_BYTES;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(withProbeForceKill(command));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectUint8StreamText({ stream: child.stdout, maxBytes: maxStdoutBytes }),
      collectUint8StreamText({ stream: child.stderr, maxBytes: MAX_PROBE_OUTPUT_BYTES }),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  );

  const oversized = stdout.truncated ? "stdout" : stderr.truncated ? "stderr" : undefined;
  if (oversized !== undefined) {
    return yield* new ProviderProbeOutputLimitError({
      stream: oversized,
      maxBytes: oversized === "stdout" ? maxStdoutBytes : MAX_PROBE_OUTPUT_BYTES,
    });
  }
  const result: CommandResult = { stdout: stdout.text, stderr: stderr.text, code: exitCode };
  if (yield* isWindowsCommandNotFound(exitCode, stderr.text)) {
    return yield* new ProviderCommandNotFoundError({
      binaryPath,
      exitCode,
      stdoutLength: stdout.text.length,
      stderrLength: stderr.text.length,
    });
  }
  return result;
}, Effect.scoped);

export function parseGenericCliVersion(output: string): string | null {
  // Consume v before the digits; v2 has no internal word boundary.
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

/** A failed `--version` run reports no version: its output can be a wrapper's, such as mise's. */
export function parseCliVersionResult(
  result: CommandResult,
  parse: (output: string) => string | null = parseGenericCliVersion,
): string | null {
  return result.code === 0 ? parse(`${result.stdout}\n${result.stderr}`) : null;
}

const BRAND_CASING: Record<string, string> = {
  glm: "GLM",
  gpt: "GPT",
  oss: "OSS",
  llm: "LLM",
  ai: "AI",
};

function humanizeModelSlug(slug: string): string {
  if (slug.includes("/")) return slug;
  const [base, tag] = slug.split(":", 2) as [string, string | undefined];
  const words = base.split(/[-_]+/u).map((w) => {
    if (/^\d/u.test(w)) return w;
    const lower = w.toLowerCase();
    return BRAND_CASING[lower] ?? w.charAt(0).toUpperCase() + w.slice(1);
  });
  const name = words.join(" ");
  return tag && tag !== "latest" ? `${name} (${tag})` : name;
}

// Custom models keep explicit capabilities or inherit driver defaults.
// A custom slug matching a built-in may rename it; ignore other overrides.
export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  customModels: ReadonlyArray<CustomModelSetting>,
  customModelCapabilities: ModelCapabilities | null,
): ReadonlyArray<ServerProviderModel> {
  const entries = readCustomModelEntries(customModels);
  if (entries.length === 0) return builtInModels;

  const nameOverrides = new Map(
    entries.filter((entry) => entry.name !== entry.slug).map((entry) => [entry.slug, entry.name]),
  );
  const resolvedBuiltInModels = builtInModels.map((model) => {
    const name = nameOverrides.get(model.slug);
    if (!name) return model;
    const { shortName: _shortName, ...rest } = model;
    return { ...rest, name };
  });
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const entry of entries) {
    if (seen.has(entry.slug)) {
      continue;
    }
    seen.add(entry.slug);
    customEntries.push({
      slug: entry.slug,
      name: entry.name === entry.slug ? humanizeModelSlug(entry.slug) : entry.name,
      isCustom: true,
      capabilities: entry.capabilities ?? customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{
        value: string;
        label: string;
        description?: string | undefined;
        isDefault?: boolean | undefined;
      }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    ...(option.isDefault ? { isDefault: true } : {}),
  }));
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  driver?: ProviderDriverKind;
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  updateRequiredModels?: ReadonlyArray<ServerProviderUpdateRequiredModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  usage?: ServerProviderUsage;
  usageLimits?: ServerProvider["usageLimits"];
  probe: ProviderProbeResult;
}): ServerProviderDraft {
  const versionAdvisory = input.driver
    ? createProviderVersionAdvisory({
        driver: input.driver,
        currentVersion: input.probe.version,
        checkedAt: input.checkedAt,
      })
    : undefined;
  return {
    displayName: input.presentation.displayName,
    ...(typeof input.presentation.supportsConversationRollback === "boolean"
      ? { supportsConversationRollback: input.presentation.supportsConversationRollback }
      : {}),
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    ...(typeof input.presentation.reportsContextWindow === "boolean"
      ? { reportsContextWindow: input.presentation.reportsContextWindow }
      : {}),
    ...(input.presentation.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: [...input.presentation.supportedRuntimeModes] }),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    // Drivers with in-app setup replace these CLI-owned defaults.
    setup: { canAuthenticate: false, canInstall: false },
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
    ...(input.updateRequiredModels?.length
      ? { updateRequiredModels: input.updateRequiredModels }
      : {}),
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
    ...(versionAdvisory ? { versionAdvisory } : {}),
    ...(input.usage ? { usage: input.usage } : {}),
    ...((input.usageLimits ?? input.probe.usageLimits)
      ? { usageLimits: input.usageLimits ?? input.probe.usageLimits }
      : {}),
    readiness: providerReadiness(input),
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  options?: { readonly maxBytes?: number | undefined },
): Effect.Effect<string, E> =>
  collectUint8StreamText({ stream, ...options }).pipe(Effect.map((collected) => collected.text));
