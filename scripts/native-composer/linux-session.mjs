import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const backend = NodeProcess.argv[2];
if (backend !== "x11" && backend !== "wayland") throw new Error("Expected x11 or wayland");
const session = NodePath.resolve(".native-composer-results", "session");
await NodeFSP.mkdir(session, { recursive: true });
const runtime = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-composer-linux-"));
const env = {
  ...NodeProcess.env,
  XDG_RUNTIME_DIR: runtime,
  XDG_SESSION_TYPE: backend,
  GDK_BACKEND: backend,
  GTK_IM_MODULE: "gtk-im-context-simple",
  XMODIFIERS: "@im=none",
  LC_ALL: "C.UTF-8",
  NATIVE_COMPOSER_BACKEND: backend,
};
delete env.WAYLAND_DISPLAY;
delete env.WAYLAND_SOCKET;
delete env.SWAYSOCK;
const log = NodeFS.openSync(NodePath.join(session, "display.log"), "w");
let display;
try {
  if (backend === "wayland") {
    delete env.DISPLAY;
    env.WLR_BACKENDS = "headless";
    env.WLR_HEADLESS_OUTPUTS = "1";
    env.WLR_RENDERER = "pixman";
    env.WLR_LIBINPUT_NO_DEVICES = "1";
    const config = NodePath.join(session, "sway.conf");
    await NodeFSP.writeFile(
      config,
      [
        "xwayland disable",
        "output * mode 1280x800",
        "seat seat0 fallback true",
        "focus_follows_mouse no",
        'for_window [app_id=".*"] floating enable',
        'for_window [title=".*"] floating enable',
        "default_border pixel 1",
        "",
      ].join("\n"),
    );
    display = NodeChildProcess.spawn("sway", ["-d", "-c", config], {
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
    const deadline = Date.now() + 30_000;
    while (true) {
      const files = await NodeFSP.readdir(runtime);
      const socket = files.find((name) => /^wayland-\d+$/.test(name));
      const ipc = files.find((name) => /^sway-ipc.*\.sock$/.test(name));
      if (socket && ipc) {
        env.WAYLAND_DISPLAY = socket;
        env.SWAYSOCK = NodePath.join(runtime, ipc);
        break;
      }
      if (Date.now() > deadline || display.exitCode !== null) throw new Error("Sway did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  } else {
    if (!env.DISPLAY) throw new Error("X11 run must be started under xvfb-run");
    display = NodeChildProcess.spawn("openbox", [], {
      env,
      detached: true,
      stdio: ["ignore", log, log],
    });
  }
  const test = NodeChildProcess.spawn(NodeProcess.execPath, ["scripts/native-composer/run.mjs"], {
    env,
    stdio: "inherit",
  });
  NodeProcess.default.exitCode = await new Promise((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  if (display?.pid) {
    try {
      NodeProcess.kill(-display.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error(error);
        NodeProcess.default.exitCode = 1;
      }
    }
  }
  NodeFS.closeSync(log);
}
