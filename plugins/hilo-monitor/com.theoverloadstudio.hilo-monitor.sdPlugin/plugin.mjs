import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { attachMonitorActions } from "./actions.mjs";

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

attachMonitorActions(
    new WebSocket(`ws://127.0.0.1:${values.port}`),
    { event: values.registerEvent, uuid: values.pluginUUID },
    async (command, signal) => {
        const operation = run(helper, [String(command)], { signal, timeout: 4500 });
        const closed = new Promise(resolve => operation.child.once("close", resolve));
        try {
            const { stdout } = await operation;
            return stdout.trim();
        } finally {
            await closed;
        }
    },
    (error) => console.error("Hilo Monitor:", error.stderr?.trim() || error.message),
);
