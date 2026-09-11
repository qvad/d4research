import * as NodeCrypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MekoHandoffClient, mapMekoArguments, resolveMekoConnection } from "./mekoHandoff.ts";

const config = {
  url: "http://127.0.0.1:8090/mcp",
  tokenEnv: "",
  agentId: "d4research-test",
  datapackId: "test-datapack",
};
const input = {
  text: "The visible context, unchanged.",
  threadId: "thread-1",
  project: "project-1",
};
const tools = Object.entries({
  conversation_create: ["agent_id", "datapack_id", "session_id"],
  artifact_put: [
    "filename",
    "content_base64",
    "content_type",
    "conversation_id",
    "agent_id",
    "datapack_id",
  ],
  artifact_get: ["content_hash", "conversation_id", "agent_id", "datapack_id"],
}).map(([name, keys]) => ({
  name,
  inputSchema: {
    type: "object" as const,
    properties: Object.fromEntries(keys.map((key) => [key, { type: "string" }])),
    required: keys,
  },
}));

function fakeMcp(
  options: {
    mismatch?: boolean;
    denied?: boolean;
    missingTool?: boolean;
    toolError?: boolean;
  } = {},
) {
  const calls: Array<{ name: string; arguments: Record<string, string> }> = [];
  let lists = 0;
  let stored = "";
  let contentHash = "";
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    if (options.denied) return new Response(null, { status: 403 });
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize")
      result = {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-meko", version: "1" },
      };
    else if (request.method === "tools/list") {
      lists++;
      result = { tools: options.missingTool ? tools.slice(0, 1) : tools };
    } else if (request.method === "tools/call") {
      calls.push(request.params);
      let value: unknown;
      if (request.params.name === "conversation_create")
        value = { id: "b656fa37-31b1-47d4-98a1-46fe2c32c175" };
      else if (request.params.name === "artifact_put") {
        stored = request.params.arguments.content_base64;
        contentHash = NodeCrypto.createHash("sha256")
          .update(Buffer.from(stored, "base64"))
          .digest("hex");
        value = { content_hash: contentHash };
      } else
        value = {
          content_hash: contentHash,
          content_base64: options.mismatch
            ? Buffer.from("wrong packet").toString("base64")
            : stored,
        };
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify(options.toolError ? { error: "agent_id_mismatch" } : value),
          },
        ],
      };
    } else throw new Error(`Unexpected MCP method ${request.method}`);
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  vi.stubGlobal("fetch", fetcher);
  return { calls, fetcher, lists: () => lists };
}
afterEach(() => vi.unstubAllGlobals());

describe("Meko MCP handoff", () => {
  it("saves exact bytes, verifies by hash, collapses concurrent and repeated saves", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    const [first, second] = await Promise.all([
      client.save(config, input),
      client.save(config, input),
    ]);
    expect(first.status).toBe("SUCCESS_WITH_EVIDENCE");
    expect(second).toEqual(first);
    expect(await client.save(config, input)).toEqual(first);
    expect(fake.calls.map((call) => call.name)).toEqual([
      "conversation_create",
      "artifact_put",
      "artifact_get",
    ]);
    expect(
      fake.calls.every(
        (call) =>
          call.arguments.agent_id === config.agentId &&
          call.arguments.datapack_id === config.datapackId,
      ),
    ).toBe(true);
    expect(JSON.stringify(client.status(config))).not.toContain(input.text);
  });

  it("reuses discovery but not a result across scope changes", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    await client.save(config, input);
    await client.save(config, { ...input, text: "Second packet" });
    expect(fake.lists()).toBe(1);
    await client.save({ ...config, datapackId: "another-datapack" }, input);
    expect(fake.lists()).toBe(2);
    expect(fake.calls.filter((call) => call.name === "artifact_put")).toHaveLength(3);
  });

  it("never treats a mismatched readback as saved", async () => {
    fakeMcp({ mismatch: true });
    const client = new MekoHandoffClient();
    expect((await client.save(config, input)).status).toBe("ERROR_TOOL_FAILURE");
    expect(client.status(config).recent[0]?.contentHash).toBeUndefined();
  });

  it.each([{ denied: true }, { toolError: true }])(
    "keeps authorization failures distinct (%o)",
    async (options) => {
      fakeMcp(options);
      expect((await new MekoHandoffClient().save(config, input)).status).toBe(
        "ERROR_AUTH_RESTRICTED",
      );
    },
  );

  it("checks capabilities without writing and refuses an incompatible API", async () => {
    const fake = fakeMcp({ missingTool: true });
    const client = new MekoHandoffClient();
    expect((await client.check(config)).status).toBe("ERROR_CONFIGURATION");
    expect(fake.calls).toHaveLength(0);
  });

  it("retrieves a known key and rejects cross-thread context", async () => {
    fakeMcp();
    const client = new MekoHandoffClient();
    const saved = await client.save(config, input);
    const reference = {
      contentHash: saved.contentHash!,
      conversationId: saved.conversationId!,
      threadId: input.threadId,
      project: input.project,
    };
    expect((await client.read(config, reference)).text).toBe(input.text);
    const denied = await client.read(config, { ...reference, threadId: "other-thread" });
    expect(denied.receipt.status).toBe("ERROR_AUTH_RESTRICTED");
    expect(denied.text).toBeUndefined();
  });

  it("requires explicit endpoint and credentials without network access", async () => {
    const fake = fakeMcp();
    const client = new MekoHandoffClient();
    expect((await client.save({ ...config, url: "" }, input)).status).toBe("ERROR_CONFIGURATION");
    expect(() => resolveMekoConnection({ ...config, tokenEnv: "MISSING" }, {})).toThrow(
      "does not contain",
    );
    expect(() => resolveMekoConnection({ ...config, url: "http://remote.example/mcp" })).toThrow(
      "Use HTTPS",
    );
    expect(fake.fetcher).not.toHaveBeenCalled();
  });

  it("validates discovered input types and drops unadvertised arguments", () => {
    const tool = tools[0]!;
    expect(
      mapMekoArguments(tool, { agent_id: "a", datapack_id: "d", session_id: "s", ignored: "x" }),
    ).toEqual({ agent_id: "a", datapack_id: "d", session_id: "s" });
    expect(() =>
      mapMekoArguments(tool, { agent_id: 3, datapack_id: "d", session_id: "s" }),
    ).toThrow("schema");
    expect(() => mapMekoArguments(tool, {})).toThrow("unsupported argument");
  });
});
