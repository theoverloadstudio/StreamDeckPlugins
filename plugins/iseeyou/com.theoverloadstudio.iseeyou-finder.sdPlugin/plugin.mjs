import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const inspectAction = "com.theoverloadstudio.iseeyou-finder.inspect";
const appBundleId = "com.theoverloadstudio.iseeyou";
const finderSelection = `
    const items = Application("Finder").selection();
    JSON.stringify(items.map((item) => item.url()));
`;

export async function inspectSelection(execute = run) {
    const { stdout } = await execute(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", finderSelection],
        { timeout: 120_000 },
    );
    const urls = JSON.parse(stdout);
    const files = urls.filter((url) => typeof url === "string" && url.startsWith("file://"))
        .map((url) => fileURLToPath(url));

    if (files.length === 0) {
        throw new Error("Select a file in Finder first.");
    }

    await execute("/usr/bin/open", ["-b", appBundleId, ...files]);
}

export function connect(socket, registration, inspect = inspectSelection) {
    let inspecting = false;

    socket.addEventListener("open", () => {
        socket.send(JSON.stringify(registration));
    });

    socket.addEventListener("message", async ({ data }) => {
        const { event, action, context } = JSON.parse(data);
        if (event !== "keyDown" || action !== inspectAction || inspecting) {
            return;
        }

        inspecting = true;
        try {
            await inspect();
        } catch (error) {
            console.error("ISeeYou could not inspect the Finder selection:", error.message);
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ event: "showAlert", context }));
            }
        } finally {
            inspecting = false;
        }
    });
}

if (import.meta.main) {
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

    connect(new WebSocket(`ws://127.0.0.1:${values.port}`), {
        event: values.registerEvent,
        uuid: values.pluginUUID,
    });
}
