import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";

const run = promisify(execFile);
const toggleAction = "com.theoverloadstudio.iseeyou-finder.inspect";
const peekAction = "com.theoverloadstudio.iseeyou-finder.peek";
const appBundleId = "com.theoverloadstudio.iseeyou";
const selectionScript = 'Application("Finder").selection().map((item) => item.url())';
const peekDirectory = join(homedir(), "Library", "Caches", appBundleId);
const peekRequest = join(peekDirectory, "stream-deck-preview.json");

async function selectedFiles(execute = run) {
    const checkProtocol = `
        ObjC.import("AppKit");
        const appURL = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier("${appBundleId}");
        const version = appURL.isNil() ? 0 : Number(ObjC.unwrap(
            $.NSBundle.bundleWithURL(appURL).objectForInfoDictionaryKey("ISeeYouStreamDeckProtocol")
        ));
        if (version !== 2) throw Error("Install the ISeeYou build with Stream Deck protocol 2.");
    `;
    await execute("/usr/bin/osascript", ["-l", "JavaScript", "-e", checkProtocol], { timeout: 5000 });
    try {
        const { stdout } = await execute(
            "/usr/bin/osascript",
            ["-l", "JavaScript", "-e", `JSON.stringify(${selectionScript});`],
            { timeout: 1500 },
        );
        return JSON.parse(stdout).filter((url) => typeof url === "string" && url.startsWith("file://"))
            .map((url) => fileURLToPath(url));
    } catch (error) {
        console.warn("ISeeYou could not read the Finder selection:", error.message);
        return [];
    }
}

function publishRequest(path, token, files) {
    mkdirSync(peekDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(peekDirectory, `${token}.tmp`);
    try {
        writeFileSync(temporary, JSON.stringify({ token, files, expiresAt: Date.now() + 20_000 }), {
            flag: "wx",
            mode: 0o600,
        });
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

function deliverRequest(path, execute = run) {
    return execute("/usr/bin/open", ["-g", "-b", appBundleId, path], { timeout: 5000 });
}

export async function toggleWindow(execute = run) {
    const files = await selectedFiles(execute);
    const token = randomUUID();
    const path = join(peekDirectory, `stream-deck-toggle-${token}.json`);
    publishRequest(path, token, files);
    try {
        await deliverRequest(path, execute);
    } catch (error) {
        rmSync(path, { force: true });
        throw error;
    }
    // LaunchServices returns before the app handles the document.
    setTimeout(() => {
        try {
            rmSync(path, { force: true });
        } catch (error) {
            console.warn("ISeeYou could not remove an expired request:", error.message);
        }
    }, 20_000).unref();
}

const peekControls = {
    select: selectedFiles,
    publish: (token, files) => publishRequest(peekRequest, token, files),
    show: () => deliverRequest(peekRequest),
    clear: () => rmSync(peekRequest, { force: true }),
};

export function connect(socket, registration, toggle = toggleWindow, peek = peekControls) {
    let toggles = Promise.resolve();
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
        clearTimeout(press?.hideTimer);
        if (!press?.renew) return;

        clearInterval(press.renew);
        try {
            peek.clear();
        } catch (error) {
            report(error, press.context);
        }
    }

    function hideAfterMinimum(press) {
        if (!press.minimumMs) {
            release();
            return;
        }
        if (press.shownAt === undefined) return;

        const remaining = press.minimumMs - (performance.now() - press.shownAt);
        if (remaining <= 0) {
            release();
        } else {
            press.hideTimer = setTimeout(() => {
                if (held === press) release();
            }, Math.ceil(remaining));
        }
    }

    socket.addEventListener("open", () => socket.send(JSON.stringify(registration)));
    socket.addEventListener("close", release);
    socket.addEventListener("message", async ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        if (held && ((context === held.context && event === "willDisappear")
            || (device === held.device && event === "deviceDidDisconnect"))) {
            release();
            return;
        }

        if (held && context === held.context && event === "keyUp") {
            if (!held.released) {
                held.released = true;
                hideAfterMinimum(held);
            }
            return;
        }

        if (event !== "keyDown") return;
        if (action === peekAction && (!held || held.context !== context || held.released)) {
            release();
            const minimum = payload?.settings?.minimumVisibleMs;
            const minimumMs = Number.isFinite(minimum) ? Math.min(5000, Math.max(0, minimum)) : 0;
            const press = { context, device, minimumMs, token: randomUUID() };
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
                if (held === press) {
                    // The app protocol has no acknowledgement for the first rendered frame.
                    press.shownAt = performance.now();
                    if (press.released) hideAfterMinimum(press);
                }
            } catch (error) {
                if (held === press) {
                    release();
                    report(error, context);
                }
            }
            return;
        }

        if (action === toggleAction) {
            toggles = toggles.then(() => toggle()).catch((error) => report(error, context));
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
