const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 220;
const maxHoldMs = 3500;
const repeatIntervalsMs = { up: 37, down: 28 };
const pulseIntervalMs = 180;
const volumeInputLifetimeMs = 250;
const isMute = command => command === "mute" || command === "force-mute";
const isVolume = command => !isMute(command) && command !== "dim" && command !== "read-dim";

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;
    let active;
    let muteJobs = 0;
    let volumeDirection;
    let volumeGeneration = 0;
    const downKeys = new Map();
    const pulses = new Map();
    const dimKeys = new Map();

    function send(event, context, payload) {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event, context, payload }));
    }

    function showDimState(result) {
        if (result !== "Dim On" && result !== "Dim Off") return;
        for (const context of dimKeys.keys()) send("setState", context, { state: result === "Dim On" ? 1 : 0 });
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
        if (active && isVolume(active.command)) active.controller.abort();
    }

    function enqueue(command, context, press) {
        const generation = volumeGeneration;
        const expires = performance.now() + volumeInputLifetimeMs;
        if (isMute(command)) muteJobs++;
        const job = pending.then(async () => {
            if (socket.readyState !== WebSocket.OPEN || (press && held !== press) ||
                (isVolume(command) && (muteJobs || generation !== volumeGeneration || performance.now() > expires))) return;
            const controller = new AbortController();
            active = { command, context, controller, press };
            try {
                const result = await adjust(command, controller.signal);
                showDimState(result);
                return result;
            } finally {
                active = undefined;
            }
        });
        pending = job.catch((error) => {
            if (error.name === "AbortError" ||
                (isVolume(command) && generation !== volumeGeneration) || command === "read-dim") return;
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

    function scheduleRepeat(press, delay) {
        if (held !== press) return;
        press.timer = setTimeout(async () => {
            if (held !== press) return;
            press.holding = true;
            const startedAt = performance.now();
            const result = await enqueue(`hold-${press.direction}`, press.context, press);
            if (held === press && result !== undefined && result !== "Limit") {
                const elapsed = performance.now() - startedAt;
                scheduleRepeat(press, Math.max(0, repeatIntervalsMs[press.direction] - elapsed));
            }
        }, delay);
    }

    socket.addEventListener("open", () => socket.send(JSON.stringify(registration)));
    socket.addEventListener("close", () => {
        stopHold();
        active?.controller.abort();
        for (const context of downKeys.keys()) releaseKey(context);
        dimKeys.clear();
    });
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        if (action === `${pluginId}.dim` && event === "willAppear") {
            dimKeys.set(context, device);
            enqueue("read-dim", context);
            return;
        }
        if (event === "keyUp" || event === "willDisappear") {
            releaseKey(context);
            if (held?.context === context) {
                const press = held;
                stopHold();
                if (event === "keyUp" && !press.holding && !muteJobs) enqueue(press.direction, context);
            }
            if (event === "willDisappear") {
                dimKeys.delete(context);
                if (active?.context === context && isVolume(active.command)) supersedeVolume();
            }
            return;
        }
        if (event === "deviceDidDisconnect") {
            for (const [key, owner] of downKeys) if (owner === device) releaseKey(key);
            for (const [key, owner] of dimKeys) if (owner === device) dimKeys.delete(key);
            stopHold();
            supersedeVolume();
            return;
        }
        if (event === "dialRotate" && action === `${pluginId}.dial`) {
            const ticks = payload?.ticks;
            if (!muteJobs && Number.isSafeInteger(ticks) && ticks !== 0) {
                stopHold();
                supersedeVolume(Math.sign(ticks));
                enqueue(Math.max(-10, Math.min(10, ticks)), context);
            }
            return;
        }
        if (event !== "keyDown") return;

        const key = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        if (!["up", "down", "mute", "dim"].includes(key) || downKeys.has(context)) return;
        if (!payload?.isInMultiAction && typeof context === "string") {
            downKeys.set(context, device);
            if (key !== "dim") startPulse(context, key);
        }

        if (key === "mute") {
            stopHold();
            supersedeVolume();
            if (active?.command === "dim") active.controller.abort();
            if (!muteJobs) enqueue("mute", context);
            else if (active?.command === "mute" && muteJobs === 1) {
                active.controller.abort();
                enqueue("force-mute", context);
            }
        } else if (key === "dim") {
            if (muteJobs) return;
            stopHold();
            supersedeVolume();
            enqueue("dim", context).then((result) => {
                if (result === undefined && dimKeys.size) enqueue("read-dim", context);
            });
        } else {
            if (muteJobs) return;
            stopHold();
            supersedeVolume(key === "up" ? 1 : -1);
            if (payload?.isInMultiAction) {
                enqueue(key, context);
            } else {
                held = { context, direction: key, holding: false };
                const press = held;
                press.limitTimer = setTimeout(() => {
                    if (held === press) stopHold();
                }, maxHoldMs);
                scheduleRepeat(held, holdDelayMs);
            }
        }
    });
}
