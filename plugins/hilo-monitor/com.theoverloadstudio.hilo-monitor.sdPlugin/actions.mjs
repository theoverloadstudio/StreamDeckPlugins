const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 220;
const maxHoldMs = 3500;
const pulseIntervalMs = 180;
const volumeInputLifetimeMs = 250;
const rapidTapMs = 240;
const maxTapBatch = 2;
const isMute = command => command === "mute" || command === "force-mute";
const modes = ["dim", "mono"];
const isVolume = command => !isMute(command) && !modes.includes(command) && !command.startsWith("read-");

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;
    let active;
    let muteJobs = 0;
    let volumeDirection;
    let volumeGeneration = 0;
    let tapCadence;
    let pendingTap;
    const downKeys = new Map();
    const pulses = new Map();
    const modeKeys = new Map();

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

    function startPulse(context, key) {
        let bright = true;
        send("setImage", context, { image: `images/${key}-pulse.svg` });
        pulses.set(context, setInterval(() => {
            bright = !bright;
            send("setImage", context, { image: `images/${key}${bright ? "-pulse" : ""}.svg` });
        }, pulseIntervalMs));
    }

    function releaseKey(context) {
        downKeys.delete(context);
        if (!pulses.has(context)) return;
        clearInterval(pulses.get(context));
        pulses.delete(context);
        send("setImage", context, {});
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
        if (isMute(command)) muteJobs++;
        const job = pending.then(async () => {
            if (batch && pendingTap === batch) pendingTap = undefined;
            if (socket.readyState !== WebSocket.OPEN || (press && held !== press) ||
                (muteJobs && !isMute(command)) ||
                (isVolume(command) && (generation !== volumeGeneration || performance.now() > expires))) return;
            const controller = new AbortController();
            active = { command, context, controller, press };
            try {
                const result = await adjust(command, controller.signal, trimDb, batch?.tiers);
                showModeState(result);
                return result;
            } finally {
                active = undefined;
            }
        });
        pending = job.catch((error) => {
            if (error.name === "AbortError" ||
                (isVolume(command) && generation !== volumeGeneration) || command.startsWith("read-")) return;
            if (isVolume(command)) {
                stopHold();
                supersedeVolume();
            }
            reportError(error);
            if (typeof context === "string") send("showAlert", context);
        }).finally(() => {
            if (isMute(command)) muteJobs--;
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
    });
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        const key = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        if (modes.includes(key) && event === "willAppear") {
            modeKeys.set(context, { key, device });
            enqueue(`read-${key}`, context);
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
                if (active?.context === context && isVolume(active.command)) supersedeVolume();
            }
            return;
        }
        if (event === "deviceDidDisconnect") {
            for (const [key, owner] of downKeys) if (owner === device) releaseKey(key);
            for (const [context, owner] of modeKeys) if (owner.device === device) modeKeys.delete(context);
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
            if (active && (modes.includes(active.command) || active.command.startsWith("read-"))) active.controller.abort();
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
