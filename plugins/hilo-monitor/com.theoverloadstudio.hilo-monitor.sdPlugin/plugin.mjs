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
    const operation = run(helper, args.map(String), { signal, timeout: 4500 });
    const closed = new Promise(resolve => operation.child.once("close", resolve));
    try {
        const { stdout } = await operation;
        return stdout.trim();
    } finally {
        await closed;
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
    (error) => console.error("Hilo Monitor:", error.stderr?.trim() || error.message),
);
