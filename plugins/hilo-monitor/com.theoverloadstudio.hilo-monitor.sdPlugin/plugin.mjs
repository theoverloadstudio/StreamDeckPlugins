import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { attachMonitorActions } from "./actions.mjs";
import { createDim } from "./dim.mjs";

const run = promisify(execFile);
const helper = fileURLToPath(new URL("./hilo-midi", import.meta.url));
const { values } = parseArgs({
    args: process.argv.slice(2).map((argument, index) =>
        index % 2 === 0 ? argument.replace(/^-([^-])/, "--$1") : argument),
    options: {
        port: { type: "string" },
        info: { type: "string" },
        pluginUUID: { type: "string" },
        registerEvent: { type: "string" },
    },
});

async function runHelper(args, signal) {
    signal.throwIfAborted();
    const operation = run(helper, args.map(String), { signal, timeout: 12000 });
    const closed = new Promise(resolve => operation.child.once("close", resolve));
    let forceExit;
    const armForceExit = () => {
        forceExit ??= setTimeout(() => operation.child.kill("SIGKILL"), 3000);
    };
    const watchdog = setTimeout(armForceExit, 12000);
    signal.addEventListener("abort", armForceExit, { once: true });
    try {
        const { stdout } = await operation;
        return stdout.trim();
    } finally {
        await closed;
        clearTimeout(watchdog);
        clearTimeout(forceExit);
        signal.removeEventListener("abort", armForceExit);
    }
}

const dim = createDim(runHelper, join(homedir(), "Library", "Application Support",
    "The Overload Studio", "Hilo Monitor", "dim.json"));
attachMonitorActions(
    new WebSocket(`ws://127.0.0.1:${values.port}`),
    { event: values.registerEvent, uuid: values.pluginUUID },
    (command, signal) => command === "dim" || command === "read-dim"
        ? dim(command === "dim", signal)
        : runHelper([command], signal),
    (error) => console.error("Hilo Monitor:", error.stderr?.trim() ||
        (error.signal ? `USB command stopped (${error.signal}).` : error.message)),
);
