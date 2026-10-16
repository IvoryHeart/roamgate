import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactNode } from "react";

// History and popstate are global, and the hook installs a module-level
// popstate listener; keep this DOM out of the shared test runner.
if (process.env.ROAMGATE_SYSTEM_BACK_DOM_TEST !== "1") {
  test("system Back regressions in an isolated runtime", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, ROAMGATE_SYSTEM_BACK_DOM_TEST: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 15_000);
} else {
  await registerDomTests();
}

async function registerDomTests() {
  const browser = new Window({ url: "http://localhost/" });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    HTMLElement: browser.HTMLElement,
    Element: browser.Element,
    Node: browser.Node,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    localStorage: browser.localStorage,
    sessionStorage: browser.sessionStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  }))
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      configurable: true,
    });
  afterAll(() => browser.happyDOM.abort());

  const { act, createElement, Fragment, StrictMode } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { initializeLayoutPreferences, updateLayoutPreferences } = await import(
    "./layoutPreferences"
  );
  const { useSystemBack } = await import("./systemBack");

  type Name = "sheet" | "composer" | "files";
  const levels = { sheet: "popup", composer: "panel", files: "panel" } as const;
  let open = new Set<Name>();
  let closed: Name[] = [];
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);

  // Composer is a child of the sheet so React runs its effects first when
  // both activate in one commit; stacking must not depend on that order.
  function Layer({ name, children }: { name: Name; children?: ReactNode }) {
    useSystemBack(
      open.has(name),
      () => {
        closed.push(name);
        show([...open].filter((candidate) => candidate !== name));
      },
      levels[name],
    );
    return createElement(Fragment, null, children);
  }
  function render() {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(
          Layer,
          { name: "sheet" },
          createElement(Layer, { name: "composer" }),
        ),
        createElement(Layer, { name: "files" }),
      ),
    );
  }
  function show(names: Name[]) {
    open = new Set(names);
    render();
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
  async function set(names: Name[]) {
    await act(async () => show(names));
    await settle();
  }
  async function userBack() {
    browser.history.back();
    await settle();
  }
  const guarded = () =>
    typeof browser.history.state === "object" &&
    browser.history.state !== null &&
    "roamgateBack" in browser.history.state;
  const at = () => browser.location.pathname;
  // Every case starts on /b, reached from /a, with nothing open.
  async function start() {
    await set([]);
    browser.history.pushState(null, "", "/a");
    browser.history.pushState(null, "", "/b");
    closed = [];
  }

  initializeLayoutPreferences();
  updateLayoutPreferences({ mode: "mobile" });

  test("one Back leaves the page after layers close together", async () => {
    await start();
    await set(["files", "composer"]);
    expect(guarded()).toBe(true);
    await set([]);
    expect([at(), guarded()]).toEqual(["/b", false]);
    await userBack();
    expect(at()).toBe("/a");
  });

  test("Back closes one layer at a time, mixed with on-screen closes", async () => {
    await start();
    await set(["composer"]);
    await set(["composer", "sheet"]);
    await userBack();
    expect(closed).toEqual(["sheet"]);
    expect([open.has("composer"), guarded()]).toEqual([true, true]);
    await set([]);
    expect([at(), guarded()]).toEqual(["/b", false]);
    await userBack();
    expect(at()).toBe("/a");
  });

  test("the higher level closes first when layers register together", async () => {
    await start();
    await set(["sheet", "composer"]);
    updateLayoutPreferences({ mode: "desktop" });
    await settle();
    expect(guarded()).toBe(false);
    updateLayoutPreferences({ mode: "mobile" });
    await settle();
    await userBack();
    expect(closed).toEqual(["sheet"]);
    expect(open.has("composer")).toBe(true);
    await set([]);
  });

  test("a layer opened while a Back is pending keeps its entry", async () => {
    await start();
    await set(["sheet"]);
    await act(async () => {
      show([]);
      await Promise.resolve();
      show(["files"]);
    });
    await settle();
    expect([open.has("files"), guarded(), at()]).toEqual([true, true, "/b"]);
    await userBack();
    expect(closed).toEqual(["files"]);
    await userBack();
    expect(at()).toBe("/a");
  });

  test("unmounting leaves history alone", async () => {
    await start();
    await set(["composer"]);
    await act(async () => root.unmount());
    await settle();
    expect([guarded(), at()]).toEqual([true, "/b"]);
    root = createRoot(container);
  });
}
