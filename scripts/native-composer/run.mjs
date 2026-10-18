import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeModule from "node:module";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const run = NodeUtil.promisify(NodeChildProcess.execFile);
const requireWeb = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"));
const requireDesktop = NodeModule.createRequire(NodePath.resolve("apps/desktop/package.json"));
const { _electron } = requireWeb("playwright");
const results = NodePath.resolve(".native-composer-results");
await NodeFSP.mkdir(results, { recursive: true });
const logs = [];
const server = NodeChildProcess.spawn("vp", ["dev", "--host", "127.0.0.1", "--port", "5733"], {
  cwd: NodePath.resolve("apps/web"),
  shell: NodeProcess.platform === "win32",
  env: { ...NodeProcess.env, T3CODE_SINGLE_ORIGIN_DEV: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (value) => logs.push(value.toString()));
server.stderr.on("data", (value) => logs.push(value.toString()));
const report = [];
let electron;
let page;
try {
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      if ((await fetch("http://127.0.0.1:5733/native-composer.html")).ok) break;
    } catch {}
    if (Date.now() > deadline || server.exitCode !== null)
      throw new Error(`Vite did not start: ${logs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const env = {
    ...NodeProcess.env,
    NATIVE_COMPOSER_URL: "http://127.0.0.1:5733/native-composer.html",
    T3CODE_HOME: NodePath.join(results, "profile"),
    T3CODE_DISABLE_AUTO_UPDATE: "true",
  };
  delete env.ELECTRON_RUN_AS_NODE;
  electron = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [
      NodePath.resolve("scripts/native-composer/electron.cjs"),
      `--user-data-dir=${NodePath.join(results, "electron")}`,
    ],
    env,
    timeout: 120_000,
    recordVideo: { dir: NodePath.join(results, "video"), size: { width: 1000, height: 600 } },
  });
  page = await electron.firstWindow();
  page.on("pageerror", (error) => logs.push(error.stack));
  await page.waitForFunction(() => Boolean(window.nativeComposer), undefined, { timeout: 120_000 });
  const hwnd = await electron.evaluate(({ BrowserWindow }, windows) => {
    const buffer = BrowserWindow.getAllWindows()[0].getNativeWindowHandle();
    return windows ? buffer.readBigUInt64LE().toString() : "0";
  }, NodeProcess.platform === "win32");
  const pid = electron.process().pid;
  async function keys(layout, sequence) {
    await electron.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.show();
      window.focus();
    });
    const result =
      NodeProcess.platform === "win32"
        ? await run(
            "pwsh",
            [
              "-NoProfile",
              "-File",
              NodePath.resolve("scripts/native-composer/windows.ps1"),
              "-Layout",
              layout === "intl" ? "00020409" : "00000409",
              "-Keys",
              sequence,
              "-WindowHandle",
              hwnd,
            ],
            { timeout: 30_000 },
          )
        : await run(
            NodePath.resolve("scripts/native-composer/macos-input"),
            [layout, sequence, String(pid)],
            { timeout: 30_000 },
          );
    logs.push(result.stdout, result.stderr);
  }
  let activeLayout;
  async function prepareLayout(layout) {
    if (activeLayout === layout) return;
    await page.locator("#control").evaluate((element) => {
      element.value = "";
      element.focus();
    });
    // Prime Chromium's layout map with a regular key before testing dead-key state.
    await keys(layout, "e");
    await page.waitForFunction(() => document.querySelector("#control").value === "e", undefined, {
      timeout: 5000,
    });
    activeLayout = layout;
  }
  // A native textarea proves the layout and OS injection work before any composer verdict.
  let probeFailures = 0;
  for (const [layout, sequence, expected] of [
    ["us", "quote", "'"],
    ["intl", "quote,pause,space", "'"],
    ["intl", "quote,pause,e", "é"],
    ["intl", "quote,space", "'"],
    ["intl", "quote,e", "é"],
  ]) {
    await prepareLayout(layout);
    await page.locator("#control").evaluate((element) => {
      element.value = "";
      element.focus();
      window.keyboardEvents.length = 0;
    });
    await keys(layout, sequence);
    let failure;
    try {
      await page.waitForFunction(
        (expected) => document.querySelector("#control").value === expected,
        expected,
        { timeout: 5000 },
      );
    } catch (error) {
      failure = String(error);
      probeFailures++;
    }
    const actual = await page.locator("#control").inputValue();
    const events = await page.evaluate(() => window.keyboardEvents);
    NodeAssert.ok(
      events.some((event) => event.type === "keydown" && event.trusted),
      "Native input did not reach the browser",
    );
    if (layout === "intl")
      NodeAssert.ok(
        events.some((event) => event.key === "Dead" || event.type === "compositionstart"),
        "No native dead-key evidence",
      );
    report.push({ type: "layout-probe", layout, sequence, expected, actual, failure, events });
    console.log(
      `${failure ? "FAIL" : "PASS"} native layout probe ${layout} ${sequence}: ${JSON.stringify(actual)}`,
    );
  }
  if (probeFailures) {
    if (NodeProcess.platform === "win32") {
      for (const sequence of ["quote,pause,space", "quote,pause,e"]) {
        const result = await run(
          "pwsh",
          [
            "-STA",
            "-NoProfile",
            "-File",
            NodePath.resolve("scripts/native-composer/windows.ps1"),
            "-Layout",
            "00020409",
            "-Keys",
            sequence,
            "-Probe",
          ],
          { timeout: 30000 },
        );
        logs.push(`WinForms ${sequence}: ${result.stdout}`, result.stderr);
      }
    }
    throw new Error(`${probeFailures} native layout probes failed; composer tests were not run`);
  }
  const cases = [
    {
      name: "ordinary-apostrophe",
      layout: "us",
      sequence: "quote",
      text: "we",
      selected: false,
      expected: "we'",
    },
    {
      name: "ordinary-surround",
      layout: "us",
      sequence: "quote",
      text: "word",
      selected: true,
      expected: "'word'",
      selection: "word",
    },
    {
      name: "dead-apostrophe",
      layout: "intl",
      sequence: "quote,pause,space",
      text: "we",
      selected: false,
      expected: "we'",
    },
    {
      name: "dead-double-quote",
      layout: "intl",
      sequence: "double,pause,space",
      text: "",
      selected: false,
      expected: '"',
    },
    {
      name: "dead-apostrophe-surround",
      layout: "intl",
      sequence: "quote,pause,space",
      text: "word",
      selected: true,
      expected: "'word'",
      selection: "word",
    },
    {
      name: "dead-double-surround",
      layout: "intl",
      sequence: "double,pause,space",
      text: "word",
      selected: true,
      expected: '"word"',
      selection: "word",
    },
    {
      name: "accented-letter",
      layout: "intl",
      sequence: "quote,pause,e",
      text: "",
      selected: false,
      expected: "é",
    },
    {
      name: "accent-replaces-selection",
      layout: "intl",
      sequence: "quote,pause,e",
      text: "word",
      selected: true,
      expected: "é",
    },
  ];
  let failures = 0;
  for (const richText of [true, false]) {
    for (const test of cases) {
      const name = `${richText ? "rich" : "plain"}-${test.name}`;
      await prepareLayout(test.layout);
      await page.evaluate(
        ({ test, richText }) => {
          window.nativeComposer.mount(test.text, test.selected, richText);
          window.keyboardEvents.length = 0;
        },
        { test, richText },
      );
      await page.screenshot({ path: NodePath.join(results, `${name}-before.png`) });
      let failure;
      try {
        await keys(test.layout, test.sequence);
        await page.waitForFunction(
          (expected) => {
            const state = window.nativeComposer.snapshot();
            return state.text === expected && !state.composing;
          },
          test.expected,
          { timeout: 5000 },
        );
        const state = await page.evaluate(() => window.nativeComposer.snapshot());
        NodeAssert.equal(state.selected, test.selection ?? "");
        if (test.selection) {
          const evidence = await page.evaluate(() => window.nativeComposer.evidence());
          NodeAssert.ok(
            evidence.events.every((event) => event.text.includes(test.text)),
            "Selected text disappeared in a transaction",
          );
          NodeAssert.ok(
            evidence.frames.every((text) => text.includes(test.text)),
            "Selected text disappeared in a rendered frame",
          );
          const undo = await page.evaluate(() => window.nativeComposer.undo());
          NodeAssert.equal(undo.text, test.text, "Undo did not restore the original text");
          const redo = await page.evaluate(() => window.nativeComposer.redo());
          NodeAssert.equal(redo.text, test.expected, "Redo did not restore wrapping");
        }
      } catch (error) {
        failure = String(error);
        failures++;
      }
      const evidence = await page.evaluate(() => ({
        ...window.nativeComposer.evidence(),
        keyboard: window.keyboardEvents,
      }));
      report.push({ name, ...test, richText, failure, ...evidence });
      await page.screenshot({ path: NodePath.join(results, `${name}-after.png`) });
      await NodeFSP.writeFile(
        NodePath.join(results, "report.json"),
        JSON.stringify(report, null, 2),
      );
      console.log(`${failure ? "FAIL" : "PASS"} ${name}${failure ? `: ${failure}` : ""}`);
    }
  }
  if (failures) throw new Error(`${failures} native composer cases failed`);
} catch (error) {
  await NodeFSP.writeFile(NodePath.join(results, "failure.txt"), error.stack ?? String(error));
  if (page) {
    await page.screenshot({ path: NodePath.join(results, "failure.png") }).catch(() => {});
    await NodeFSP.writeFile(
      NodePath.join(results, "keyboard-events.json"),
      JSON.stringify(
        await page.evaluate(() => window.keyboardEvents ?? []).catch(() => []),
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await NodeFSP.writeFile(NodePath.join(results, "report.json"), JSON.stringify(report, null, 2));
  await NodeFSP.writeFile(NodePath.join(results, "runner.log"), logs.join("\n"));
  if (electron) await electron.close();
  server.kill();
}
