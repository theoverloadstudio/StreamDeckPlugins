import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const inspectAction = "com.theoverloadstudio.iseeyou-finder.inspect";
const peekAction = "com.theoverloadstudio.iseeyou-finder.peek";
const appBundleId = "com.theoverloadstudio.iseeyou";
const selectionScript = 'Application("Finder").selection().map((item) => item.url())';
const peekDirectory = join(homedir(), "Library", "Caches", appBundleId);
const peekRequest = join(peekDirectory, "stream-deck-preview.json");

async function selectedFiles(execute = run, peek = false) {
    const checkVersion = `
        ObjC.import("AppKit");
        const appURL = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("${appBundleId}");
        const build = appURL.isNil() ? 0 :
            Number(ObjC.unwrap($.NSBundle.bundleWithURL(appURL).objectForInfoDictionaryKey("CFBundleVersion")));
        if (!(build >= 5)) throw Error("Install and open ISeeYou 1.4 or later to use Hold to Inspect.");
    `;
    const script = (peek ? checkVersion : "") + `JSON.stringify(${selectionScript});`;
    const { stdout } = await execute(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script],
        { timeout: 120_000 },
    );
    const files = JSON.parse(stdout).filter((url) => typeof url === "string" && url.startsWith("file://"))
        .map((url) => fileURLToPath(url));

    if (files.length === 0) {
        throw new Error("Select a file in Finder first.");
    }

    return files;
}

export async function inspectSelection(execute = run) {
    const files = await selectedFiles(execute);
    await execute("/usr/bin/open", ["-b", appBundleId, ...files]);
}

function publishPeek(token, files) {
    mkdirSync(peekDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(peekDirectory, `${token}.tmp`);
    try {
        writeFileSync(temporary, JSON.stringify({ token, files, expiresAt: Date.now() + 20_000 }), {
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporary, peekRequest);
    } finally {
        rmSync(temporary, { force: true });
    }
}

const peekControls = {
    select: () => selectedFiles(run, true),
    publish: publishPeek,
    show: () => run("/usr/bin/open", ["-g", "-b", appBundleId, peekRequest], { timeout: 5_000 }),
    clear: () => rmSync(peekRequest, { force: true }),
};

export function connect(socket, registration, inspect = inspectSelection, peek = peekControls) {
    let inspecting = false;
    let held;

    function report(error, context) {
        console.error("ISeeYou:", error.message);
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ event: "showAlert", context }));
        }
    }

    function release() {
        const press = held;
        held = undefined;
        if (!press?.renew) return;

        clearInterval(press.renew);
        try {
            peek.clear();
        } catch (error) {
            report(error, press.context);
        }
    }

    socket.addEventListener("open", () => socket.send(JSON.stringify(registration)));
    socket.addEventListener("close", release);
    socket.addEventListener("message", async ({ data }) => {
        const { event, action, context, device } = JSON.parse(data);
        if (held && ((context === held.context && (event === "keyUp" || event === "willDisappear"))
            || (device === held.device && event === "deviceDidDisconnect"))) {
            release();
            return;
        }

        if (event !== "keyDown") return;
        if (action === peekAction && held?.context !== context) {
            release();
            const press = { context, device, token: randomUUID() };
            held = press;
            try {
                const files = await peek.select();
                if (held !== press) return;

                const publish = () => peek.publish(press.token, files);
                publish();
                press.renew = setInterval(() => {
                    try {
                        publish();
                    } catch (error) {
                        release();
                        report(error, context);
                    }
                }, 5000);
                await peek.show();
            } catch (error) {
                if (held === press) {
                    release();
                    report(error, context);
                }
            }
            return;
        }

        if (action !== inspectAction || inspecting) return;
        release();
        inspecting = true;
        try {
            await inspect();
        } catch (error) {
            report(error, context);
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
