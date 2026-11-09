import { keyImage } from "./key-art.mjs";

const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 220;
const maxHoldMs = 3500;
const pulseIntervalMs = 180;
const volumeInputLifetimeMs = 250;
const rapidTapMs = 275;
const maxTapBatch = 2;
const statusIntervalMs = 650;
const isMute = command => command === "mute" || command === "force-mute";
const isRead = command => typeof command === "string" && command.startsWith("read-");
const modes = ["dim", "mono"];
const isVolume = command => !isMute(command) && !modes.includes(command) && !isRead(command);

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;
    let active;
    const muteJobs = { monitor: 0, phones: 0 };
    const muting = () => muteJobs.monitor || muteJobs.phones;
    let volumeDirection;
    let volumeGeneration = 0;
    let tapCadence;
    let pendingTap;
    let statusTimer;
    let queuedJobs = 0;
    const outputs = { monitor: {}, phones: {} };
    let lastStatusOutput;
    let dimActive = false;
    let dimKnown = false;
    let dimIntent;
    let dimRead;
    let dimPressPending = false;
    const downKeys = new Map();
    const pulses = new Map();
    const modeKeys = new Map();
    const statusKeys = new Map();

    function send(event, context, payload) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
    }

    function showModeState(result) {
        const match = /^(Dim|Mono) (On|Off)$/.exec(result);
        if (!match) return;
        if (match[1] === "Dim") {
            dimActive = match[2] === "On";
            dimKnown = true;
        }
        for (const [context, { key }] of modeKeys) {
            if (key === match[1].toLowerCase()) send("setState", context, { state: match[2] === "On" ? 1 : 0 });
        }
        if (match[1] === "Dim") renderStatus();
    }

    function renderStatus() {
        for (const [context, view] of statusKeys) {
            const { gain, muteBits } = outputs[view.output];
            const bright = pulses.get(context)?.bright ?? false;
            const transition = view.key === "dim" ? dimIntent?.target : undefined;
            const signature = view.key === "dim" ? `${gain}:${dimActive}:${transition}` :
                `${view.key === "mute" ? muteBits : gain}:${bright}`;
            if (view.last === signature) continue;
            view.last = signature;
            send("setImage", context, {
                image: keyImage(view.key, { gain, active: dimActive, transition, muteBits, bright, phones: view.output === "phones" }),
            });
        }
    }

    function showGain(output, value) {
        if (!Number.isInteger(value) || value < 0 || value > 192) return;
        outputs[output].gain = value;
        renderStatus();
    }

    function scheduleStatus(delay, preferredOutput) {
        clearTimeout(statusTimer);
        if (!statusKeys.size || socket.readyState !== WebSocket.OPEN) return;
        const visible = [...new Set([...statusKeys.values()].map(view => view.output))];
        statusTimer = setTimeout(() => {
            if (queuedJobs || held) {
                scheduleStatus();
                return;
            }
            const output = visible.includes(preferredOutput) ? preferredOutput :
                visible.find(candidate => candidate !== lastStatusOutput) ?? visible[0];
            lastStatusOutput = output;
            enqueue("read-status", undefined, undefined, undefined, undefined, output);
        }, delay ?? statusIntervalMs / visible.length);
    }

    function dropHiddenStatus() {
        for (const output of Object.keys(outputs)) {
            if (![...statusKeys.values()].some(view => view.output === output)) outputs[output] = {};
        }
        scheduleStatus();
    }

    function startPulse(context) {
        const pulse = { bright: true };
        pulses.set(context, pulse);
        renderStatus();
        pulse.timer = setInterval(() => {
            pulse.bright = !pulse.bright;
            renderStatus();
        }, pulseIntervalMs);
    }

    function releaseKey(context) {
        downKeys.delete(context);
        const pulse = pulses.get(context);
        if (!pulse) return;
        clearInterval(pulse.timer);
        pulses.delete(context);
        renderStatus();
    }

    function stopHold() {
        clearTimeout(held?.timer);
        clearTimeout(held?.limitTimer);
        if (active?.press === held && held) active.controller.abort();
        held = undefined;
    }

    function supersedeVolume(direction) {
        if (direction !== undefined && volumeDirection === direction) return;
        volumeDirection = direction;
        volumeGeneration++;
        tapCadence = undefined;
        pendingTap = undefined;
        if (active && isVolume(active.command)) active.controller.abort();
    }

    function enqueue(command, context, press, trimDb, batch, output = "monitor", intent) {
        const generation = volumeGeneration;
        const expires = performance.now() + volumeInputLifetimeMs;
        const monitorUp = output === "monitor" && (command === "up" || command === "hold-up");
        if (monitorUp && !dimKnown) readDim(context);
        if (!isRead(command) && active?.command === "read-status") active.controller.abort();
        queuedJobs++;
        if (isMute(command)) muteJobs[output]++;
        const job = pending.then(async () => {
            if (batch && pendingTap === batch) pendingTap = undefined;
            if (socket.readyState !== WebSocket.OPEN || (press && held !== press) ||
                (intent && dimIntent !== intent) ||
                (muting() && !isMute(command)) ||
                (isVolume(command) && (generation !== volumeGeneration || performance.now() > expires))) return;
            if (monitorUp) {
                if (!dimKnown) {
                    if (typeof context === "string") send("showAlert", context);
                    return;
                }
                if (clearDimOnUp(context)) return;
            }
            const controller = new AbortController();
            active = { command, context, controller, press, output };
            try {
                const result = await adjust(command, controller.signal, trimDb, batch?.tiers,
                    isVolume(command) && statusKeys.size ? value => showGain(output, value) : undefined, output, intent?.target);
                if (controller.signal.aborted) return;
                if (command === "read-status") {
                    const match = /^STATUS (\d+) ([0-3])$/.exec(result);
                    if (!match || Number(match[1]) > 192) throw new Error("Invalid Hilo output status.");
                    outputs[output].muteBits = Number(match[2]);
                    showGain(output, Number(match[1]));
                } else if (isMute(command) && (result === "Muted" || result === "Unmuted")) {
                    outputs[output].muteBits = result === "Muted" ? 3 : 0;
                    renderStatus();
                }
                showModeState(result);
                return result;
            } finally {
                active = undefined;
            }
        });
        pending = job.catch((error) => {
            if (command === "read-status" && error.name !== "AbortError") {
                outputs[output] = {};
                renderStatus();
            }
            if (error.name === "AbortError" ||
                (isVolume(command) && generation !== volumeGeneration) || isRead(command)) return;
            if (isVolume(command)) {
                stopHold();
                supersedeVolume();
            }
            reportError(error);
            if (typeof context === "string") send("showAlert", context);
        }).finally(() => {
            queuedJobs--;
            if (isMute(command)) muteJobs[output]--;
            if (!queuedJobs) {
                if (command === "read-status") scheduleStatus();
                else scheduleStatus(65, output);
            }
        });
        return job.catch(() => undefined);
    }

    function readDim(context) {
        if (dimRead) return;
        dimRead = enqueue("read-dim", context).then(result => {
            dimRead = undefined;
            const pressed = dimPressPending;
            dimPressPending = false;
            if (pressed && result && socket.readyState === WebSocket.OPEN) pressDim(context);
            else if (pressed && typeof context === "string") send("showAlert", context);
        });
    }

    function pressDim(context) {
        if (!dimKnown) {
            stopHold();
            supersedeVolume();
            dimPressPending = !dimPressPending;
            readDim(context);
            return;
        }
        const wasOn = dimIntent ? dimIntent.target === "on" : dimActive;
        requestDim(context, wasOn ? "off" : "on");
    }

    function clearDimOnUp(context) {
        if (dimIntent?.target === "off") return true;
        if (!dimActive && dimIntent?.target !== "on") return false;
        requestDim(context, "off");
        return true;
    }

    function requestDim(context, target) {
        stopHold();
        supersedeVolume();
        const intent = { target };
        dimIntent = intent;
        if (active?.command === "dim") active.controller.abort();
        renderStatus();
        enqueue("dim", context, undefined, undefined, undefined, "monitor", intent).then(result => {
            if (dimIntent !== intent) return;
            dimIntent = undefined;
            renderStatus();
            if (!result) {
                dimKnown = false;
                if (socket.readyState === WebSocket.OPEN) readDim(context);
            }
        });
    }

    function tapVolume(direction, context, output) {
        const now = performance.now();
        const tier = tapCadence?.direction === direction && now - tapCadence.at <= rapidTapMs
            ? Math.min(3, tapCadence.tier + 1) : 1;
        tapCadence = { direction, at: now, tier };
        // Start the first tap immediately. While a ramp is busy, keep one
        // bounded batch with the original expiry rather than a growing queue.
        if (pendingTap) {
            if (pendingTap.tiers.length < maxTapBatch) pendingTap.tiers.push(tier);
            return;
        }
        const batch = { tiers: [tier] };
        pendingTap = batch;
        enqueue(direction, context, undefined, undefined, batch, output);
    }

    function scheduleHold(press) {
        press.timer = setTimeout(() => {
            if (held !== press) return;
            press.holding = true;
            supersedeVolume();
            enqueue(`hold-${press.direction}`, press.context, press, undefined, undefined, press.output);
        }, holdDelayMs);
    }

    socket.addEventListener("open", () => socket.send(JSON.stringify(registration)));
    socket.addEventListener("close", () => {
        stopHold();
        active?.controller.abort();
        for (const context of downKeys.keys()) releaseKey(context);
        modeKeys.clear();
        statusKeys.clear();
        clearTimeout(statusTimer);
    });
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        const actionKey = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        const output = actionKey.startsWith("phones-") ? "phones" : "monitor";
        const key = output === "phones" ? actionKey.slice("phones-".length) : actionKey;
        if (output === "phones" && !["up", "down", "mute"].includes(key)) return;
        if (event === "willAppear") {
            if (["dim", "mute", "up", "down"].includes(key)) {
                // Remove the old Dim title overlay on keys carried over from v1.9.
                if (key === "dim") send("setTitle", context, { title: "" });
                statusKeys.set(context, { key, device, output });
                renderStatus();
                scheduleStatus(0);
            }
            if (modes.includes(key)) {
                modeKeys.set(context, { key, device });
                if (key === "dim") readDim(context);
                else enqueue(`read-${key}`, context);
            }
            if (output === "monitor" && key === "up" && !dimKnown) readDim(context);
            return;
        }
        if (event === "keyUp" || event === "willDisappear") {
            releaseKey(context);
            if (held?.context === context) {
                const press = held;
                stopHold();
                if (event === "keyUp" && !press.holding && performance.now() - press.startedAt < holdDelayMs && !muting()) tapVolume(press.direction, context, press.output);
            }
            if (event === "willDisappear") {
                modeKeys.delete(context);
                statusKeys.delete(context);
                dropHiddenStatus();
                if (active?.context === context && isVolume(active.command)) supersedeVolume();
            }
            return;
        }
        if (event === "deviceDidDisconnect") {
            for (const [key, owner] of downKeys) if (owner === device) releaseKey(key);
            for (const [context, owner] of modeKeys) if (owner.device === device) modeKeys.delete(context);
            for (const [context, owner] of statusKeys) if (owner.device === device) statusKeys.delete(context);
            dropHiddenStatus();
            stopHold();
            supersedeVolume();
            return;
        }
        if (event === "dialRotate" && action === `${pluginId}.dial`) {
            const ticks = payload?.ticks;
            if (!muting() && Number.isSafeInteger(ticks) && ticks !== 0) {
                stopHold();
                supersedeVolume(`monitor:${Math.sign(ticks)}`);
                tapCadence = undefined;
                enqueue(Math.max(-10, Math.min(10, ticks)), context);
            }
            return;
        }
        if (event !== "keyDown") return;

        // Dim is a toggle on keyDown. It has no held gesture to release.
        if (key === "dim") {
            pressDim(context);
            return;
        }
        if (!["up", "down", "mute", ...modes].includes(key) || downKeys.has(context)) return;
        if (!payload?.isInMultiAction && typeof context === "string") {
            downKeys.set(context, device);
            if (!modes.includes(key)) startPulse(context);
        }

        if (key === "mute") {
            stopHold();
            supersedeVolume();
            if (active && (modes.includes(active.command) || isRead(active.command))) active.controller.abort();
            if (!muteJobs[output]) enqueue("mute", context, undefined, undefined, undefined, output);
            else if (active?.command === "mute" && active.output === output && muteJobs[output] === 1) {
                active.controller.abort();
                enqueue("force-mute", context, undefined, undefined, undefined, output);
            }
        } else if (modes.includes(key)) {
            if (muting()) return;
            stopHold();
            supersedeVolume();
            enqueue(key, context, undefined, payload?.settings?.monoTrimDb).then((result) => {
                if (result === undefined && modeKeys.has(context)) enqueue(`read-${key}`, context);
            });
        } else {
            if (muting()) return;
            if (output === "monitor" && key === "up" && clearDimOnUp(context)) return;
            stopHold();
            supersedeVolume(`${output}:${key === "up" ? 1 : -1}`);
            if (payload?.isInMultiAction) {
                tapCadence = undefined;
                enqueue(key, context, undefined, undefined, undefined, output);
            } else {
                held = { context, direction: key, output, holding: false, startedAt: performance.now() };
                const press = held;
                press.limitTimer = setTimeout(() => {
                    if (held === press) stopHold();
                }, maxHoldMs);
                scheduleHold(held);
            }
        }
    });
}
