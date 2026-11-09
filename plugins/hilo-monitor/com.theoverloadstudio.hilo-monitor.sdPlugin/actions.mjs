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
    let muteJobs = 0;
    let volumeDirection;
    let volumeGeneration = 0;
    let tapCadence;
    let pendingTap;
    let statusTimer;
    let queuedJobs = 0;
    let analogGain;
    let muteBits;
    const downKeys = new Map();
    const pulses = new Map();
    const modeKeys = new Map();
    const statusKeys = new Map();
    const muteImages = ["live", "left", "right", "muted"];

    function send(event, context, payload) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
    }

    function showModeState(result) {
        const match = /^(Dim|Mono) (On|Off)$/.exec(result);
        if (!match) return;
        for (const [context, { key }] of modeKeys) {
            if (key === match[1].toLowerCase()) send("setState", context, { state: match[2] === "On" ? 1 : 0 });
        }
    }

    function renderStatus() {
        for (const [context, view] of statusKeys) {
            if (view.key === "dim") {
                const title = analogGain === undefined ? "—" : analogGain === 0 ? "OFF" :
                    ((analogGain - 192) * 0.5).toFixed(1).replace("-", "−");
                if (view.last !== title) send("setTitle", context, { title });
                view.last = title;
            } else {
                const image = muteImages[muteBits] ?? "unknown";
                const suffix = (muteBits === 0 || muteBits === 3) && pulses.get(context)?.bright ? "-pulse" : "";
                const path = `images/mute-${image}${suffix}.svg`;
                if (view.last !== path) send("setImage", context, { image: path });
                view.last = path;
            }
        }
    }

    function showGain(value) {
        if (!Number.isInteger(value) || value < 0 || value > 192) return;
        analogGain = value;
        renderStatus();
    }

    function scheduleStatus(delay = statusIntervalMs) {
        clearTimeout(statusTimer);
        if (!statusKeys.size || socket.readyState !== WebSocket.OPEN) return;
        statusTimer = setTimeout(() => {
            if (!queuedJobs && !held) enqueue("read-status");
            else scheduleStatus();
        }, delay);
    }

    function startPulse(context, key) {
        const pulse = { bright: true, key };
        const render = () => {
            if (key === "mute") renderStatus();
            else send("setImage", context, { image: `images/${key}${pulse.bright ? "-pulse" : ""}.svg` });
        };
        pulses.set(context, pulse);
        render();
        pulse.timer = setInterval(() => {
            pulse.bright = !pulse.bright;
            render();
        }, pulseIntervalMs);
    }

    function releaseKey(context) {
        downKeys.delete(context);
        const pulse = pulses.get(context);
        if (!pulse) return;
        clearInterval(pulse.timer);
        pulses.delete(context);
        if (pulse.key === "mute") renderStatus();
        else send("setImage", context, {});
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

    function enqueue(command, context, press, trimDb, batch) {
        const generation = volumeGeneration;
        const expires = performance.now() + volumeInputLifetimeMs;
        if (!isRead(command) && active?.command === "read-status") active.controller.abort();
        queuedJobs++;
        if (isMute(command)) muteJobs++;
        const job = pending.then(async () => {
            if (batch && pendingTap === batch) pendingTap = undefined;
            if (socket.readyState !== WebSocket.OPEN || (press && held !== press) ||
                (muteJobs && !isMute(command)) ||
                (isVolume(command) && (generation !== volumeGeneration || performance.now() > expires))) return;
            const controller = new AbortController();
            active = { command, context, controller, press };
            try {
                const result = await adjust(command, controller.signal, trimDb, batch?.tiers,
                    isVolume(command) && statusKeys.size ? showGain : undefined);
                if (controller.signal.aborted) return;
                if (command === "read-status") {
                    const match = /^STATUS (\d+) ([0-3])$/.exec(result);
                    if (!match || Number(match[1]) > 192) throw new Error("Invalid Monitor Out status.");
                    muteBits = Number(match[2]);
                    showGain(Number(match[1]));
                } else if (isMute(command) && (result === "Muted" || result === "Unmuted")) {
                    muteBits = result === "Muted" ? 3 : 0;
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
                analogGain = muteBits = undefined;
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
            if (isMute(command)) muteJobs--;
            if (!queuedJobs) scheduleStatus(command === "read-status" ? statusIntervalMs : 65);
        });
        return job.catch(() => undefined);
    }

    function tapVolume(direction, context) {
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
        enqueue(direction, context, undefined, undefined, batch);
    }

    function scheduleHold(press) {
        press.timer = setTimeout(() => {
            if (held !== press) return;
            press.holding = true;
            supersedeVolume();
            enqueue(`hold-${press.direction}`, press.context, press);
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
        const key = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        if (event === "willAppear") {
            if (key === "dim" || key === "mute") {
                statusKeys.set(context, { key, device });
                renderStatus();
                scheduleStatus(0);
            }
            if (modes.includes(key)) {
                modeKeys.set(context, { key, device });
                enqueue(`read-${key}`, context);
            }
            return;
        }
        if (event === "keyUp" || event === "willDisappear") {
            releaseKey(context);
            if (held?.context === context) {
                const press = held;
                stopHold();
                if (event === "keyUp" && !press.holding && performance.now() - press.startedAt < holdDelayMs && !muteJobs) tapVolume(press.direction, context);
            }
            if (event === "willDisappear") {
                modeKeys.delete(context);
                statusKeys.delete(context);
                if (!statusKeys.size) {
                    clearTimeout(statusTimer);
                    analogGain = muteBits = undefined;
                }
                if (active?.context === context && isVolume(active.command)) supersedeVolume();
            }
            return;
        }
        if (event === "deviceDidDisconnect") {
            for (const [key, owner] of downKeys) if (owner === device) releaseKey(key);
            for (const [context, owner] of modeKeys) if (owner.device === device) modeKeys.delete(context);
            for (const [context, owner] of statusKeys) if (owner.device === device) statusKeys.delete(context);
            if (!statusKeys.size) {
                clearTimeout(statusTimer);
                analogGain = muteBits = undefined;
            }
            stopHold();
            supersedeVolume();
            return;
        }
        if (event === "dialRotate" && action === `${pluginId}.dial`) {
            const ticks = payload?.ticks;
            if (!muteJobs && Number.isSafeInteger(ticks) && ticks !== 0) {
                stopHold();
                supersedeVolume(Math.sign(ticks));
                tapCadence = undefined;
                enqueue(Math.max(-10, Math.min(10, ticks)), context);
            }
            return;
        }
        if (event !== "keyDown") return;

        if (!["up", "down", "mute", ...modes].includes(key) || downKeys.has(context)) return;
        if (!payload?.isInMultiAction && typeof context === "string") {
            downKeys.set(context, device);
            if (!modes.includes(key)) startPulse(context, key);
        }

        if (key === "mute") {
            stopHold();
            supersedeVolume();
            if (active && (modes.includes(active.command) || isRead(active.command))) active.controller.abort();
            if (!muteJobs) enqueue("mute", context);
            else if (active?.command === "mute" && muteJobs === 1) {
                active.controller.abort();
                enqueue("force-mute", context);
            }
        } else if (modes.includes(key)) {
            if (muteJobs) return;
            stopHold();
            supersedeVolume();
            enqueue(key, context, undefined, payload?.settings?.monoTrimDb).then((result) => {
                if (result === undefined && modeKeys.has(context)) enqueue(`read-${key}`, context);
            });
        } else {
            if (muteJobs) return;
            stopHold();
            supersedeVolume(key === "up" ? 1 : -1);
            if (payload?.isInMultiAction) {
                tapCadence = undefined;
                enqueue(key, context);
            } else {
                held = { context, direction: key, holding: false, startedAt: performance.now() };
                const press = held;
                press.limitTimer = setTimeout(() => {
                    if (held === press) stopHold();
                }, maxHoldMs);
                scheduleHold(held);
            }
        }
    });
}
