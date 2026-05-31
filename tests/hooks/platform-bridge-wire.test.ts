/**
 * PRD-context-as-a-service §5.2 — Forwarder injection point.
 *
 * Verifies that hooks/session-loaders.mjs::attributeAndInsertEvents wires
 * platform-bridge.mjs::maybeForward correctly:
 *  1. With valid platform.json, every event triggers one POST (wire works).
 *  2. Without platform.json, the loop is skipped entirely — no fetch,
 *     no per-event readFileSync (negative-cache invariant).
 *  3. After 60s TTL, a deleted platform.json eventually halts forwarding
 *     (TTL invalidation).
 */

import { describe, test, beforeEach, afterEach, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface MockDb {
  getSessionStats: () => { project_dir?: string } | null;
  getLatestAttributedProjectDir: () => string | null;
  bulkInsertEvents: ReturnType<typeof vi.fn>;
}

function makeMockDb(): MockDb {
  return {
    getSessionStats: () => null,
    getLatestAttributedProjectDir: () => null,
    bulkInsertEvents: vi.fn(),
  };
}

function makeEvents(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    type: "tool_use",
    category: "edit",
    data: `event-${i}`,
  }));
}

const resolveAttribs = (evs: { type: string }[]) =>
  evs.map(() => ({ project_dir: "/tmp/p", project_hash: "abc" }));

async function importFresh() {
  vi.resetModules();
  const bridge = await import("../../hooks/platform-bridge.mjs");
  const loaders = await import("../../hooks/session-loaders.mjs");
  return { bridge, loaders };
}

describe("platform-bridge wire — session-loaders forwards events", () => {
  let fakeHome: string;
  let origHome: string | undefined;
  let origXdg: string | undefined;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-bridge-wire-"));
    origHome = process.env.HOME;
    origXdg = process.env.XDG_CONFIG_HOME;
    process.env.HOME = fakeHome;
    delete process.env.XDG_CONFIG_HOME;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200 }),
    );
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origXdg !== undefined) process.env.XDG_CONFIG_HOME = origXdg;
    else delete process.env.XDG_CONFIG_HOME;
    try {
      rmSync(fakeHome, { recursive: true, force: true });
    } catch {}
    vi.doUnmock("../../hooks/platform-bridge.mjs");
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test("with NO platform.json, loop is gated — maybeForward never called", async () => {
    vi.resetModules();
    vi.doMock("../../hooks/platform-bridge.mjs", () => ({
      maybeForward: vi.fn(),
      hasPlatformConfig: vi.fn(() => false),
      configPath: vi.fn(),
      buildUrl: vi.fn(),
      sanitizeEvent: vi.fn(),
    }));

    const bridge = await import("../../hooks/platform-bridge.mjs");
    const { attributeAndInsertEvents } = await import("../../hooks/session-loaders.mjs");

    const db = makeMockDb();
    attributeAndInsertEvents(
      db,
      "session-test",
      makeEvents(30),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    expect(bridge.hasPlatformConfig).toHaveBeenCalledTimes(1);
    expect(bridge.maybeForward).not.toHaveBeenCalled();

    vi.doUnmock("../../hooks/platform-bridge.mjs");
  });

  test("no platform.json + many calls: FS probed at most once per TTL window", async () => {
    // No platform.json written — HOME points at a fresh empty temp dir.
    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();
    for (let n = 0; n < 5; n++) {
      loaders.attributeAndInsertEvents(
        db,
        `session-${n}`,
        makeEvents(10),
        { workspace_roots: ["/tmp/p"] },
        "/tmp/p",
        "PostToolUse",
        resolveAttribs,
      );
    }

    expect(bridge._internal.fsLoads).toBe(1);
  });

  test("TTL invalidation: platform.json removed mid-session halts forwarding after TTL", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    vi.setSystemTime(new Date("2026-06-01T00:00:00Z"));

    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    const cfgFile = join(fakeHome, ".context-mode", "platform.json");
    writeFileSync(
      cfgFile,
      JSON.stringify({
        api_key: "ctxm_ttl_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders, bridge } = await importFresh();
    bridge._internal.resetState();

    const db = makeMockDb();

    loaders.attributeAndInsertEvents(
      db,
      "session-before",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    const beforeRemove = fetchSpy.mock.calls.length;
    expect(beforeRemove).toBe(2);

    rmSync(cfgFile);
    vi.advanceTimersByTime(61_000);

    loaders.attributeAndInsertEvents(
      db,
      "session-after",
      makeEvents(2),
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );
    await vi.advanceTimersByTimeAsync(10);

    expect(fetchSpy.mock.calls.length).toBe(beforeRemove);

    vi.useRealTimers();
  });

  test("with valid platform.json, N events triggers N fetch calls", async () => {
    mkdirSync(join(fakeHome, ".context-mode"), { recursive: true });
    writeFileSync(
      join(fakeHome, ".context-mode", "platform.json"),
      JSON.stringify({
        api_key: "ctxm_wire_test",
        platform_url: "https://example.test/api/v1",
      }),
    );

    const { loaders } = await importFresh();
    const db = makeMockDb();
    const events = makeEvents(3);

    loaders.attributeAndInsertEvents(
      db,
      "session-test",
      events,
      { workspace_roots: ["/tmp/p"] },
      "/tmp/p",
      "PostToolUse",
      resolveAttribs,
    );

    // Wait for fire-and-forget POSTs to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(db.bulkInsertEvents).toHaveBeenCalledTimes(1);
  });
});
