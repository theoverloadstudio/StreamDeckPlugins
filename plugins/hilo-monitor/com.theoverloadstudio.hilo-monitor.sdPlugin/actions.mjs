const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 125;
const repeatIntervalsMs = { up: 37, down: 28 };
const pulseIntervalMs = 180;
const isVolume = command => command !== "mute" && command !== "dim" && command !== "read-dim";

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;
    let active;
    let volumeDirection;
    let volumeGeneration = 0;
    const pulses = new Map();
    const dimKeys = new Map();
    const dimPressed = new Set();

    function showDimState(result) {
        if (socket.readyState !== WebSocket.OPEN || (result !== "Dim On" && result !== "Dim Off")) return;
        for (const context of dimKeys.keys()) {
            socket.send(JSON.stringify({ event: "setState", context, payload: { state: result === "Dim On" ? 1 : 0 } }));
        }
    }

    function setImage(context, image) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ event: "setImage", context, payload: { image } }));
        }
    }

    function startPulse(context, device, key) {
        let bright = true;
        setImage(context, `images/${key}-pulse.svg`);
        const timer = setInterval(() => {
            bright = !bright;
            setImage(context, `images/${key}${bright ? "-pulse" : ""}.svg`);
        }, pulseIntervalMs);
        pulses.set(context, { device, timer });
    }

    function stopPulse(context) {
        const pulse = pulses.get(context);
        if (!pulse) return;
        clearInterval(pulse.timer);
        pulses.delete(context);
        setImage(context);
    }

    function stopHold() {
        clearTimeout(held?.timer);
        if (active?.repeat) active.controller.abort();
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
        const job = pending.then(async () => {
            if (socket.readyState === WebSocket.OPEN && (!press || held === press) &&
                (!isVolume(command) || generation === volumeGeneration)) {
                const controller = new AbortController();
                active = { command, context, controller, repeat: !!press };
                try {
                    const result = await adjust(command, controller.signal);
                    showDimState(result);
                    return result;
                } finally {
                    active = undefined;
                }
            }
        });
        pending = job.catch((error) => {
            if (error.name === "AbortError" ||
                (isVolume(command) && generation !== volumeGeneration) || command === "read-dim") return;
            if (held && held.context === context && (!press || held === press)) stopHold();
            reportError(error);
            if (socket.readyState === WebSocket.OPEN && typeof context === "string") {
                socket.send(JSON.stringify({ event: "showAlert", context }));
            }
        });
        return job.catch(() => undefined);
    }

    function scheduleRepeat(press, delay) {
        if (held !== press) return;

        press.timer = setTimeout(async () => {
            const startedAt = performance.now();
            const result = await enqueue(
                `hold-${press.direction}`,
                press.context,
                press,
            );
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
        for (const context of pulses.keys()) stopPulse(context);
        dimKeys.clear();
        dimPressed.clear();
    });
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        if (action === `${pluginId}.dim` && event === "willAppear") {
            dimKeys.set(context, device);
            enqueue("read-dim", context);
            return;
        }
        if (event === "keyUp" || event === "willDisappear") stopPulse(context);
        if (event === "keyUp" || event === "willDisappear") dimPressed.delete(context);
        if (event === "willDisappear") {
            dimKeys.delete(context);
            if (active?.context === context && isVolume(active.command)) active.controller.abort();
        }
        if (event === "deviceDidDisconnect") {
            for (const [key, pulse] of pulses) {
                if (pulse.device === device) {
                    if (active?.context === key && isVolume(active.command)) active.controller.abort();
                    stopPulse(key);
                }
            }
            for (const [key, owner] of dimKeys) {
                if (owner === device) {
                    dimKeys.delete(key);
                    dimPressed.delete(key);
                }
            }
        }
        if (held && ((held.context === context && (event === "keyUp" || event === "willDisappear"))
            || (held.device === device && event === "deviceDidDisconnect"))) {
            stopHold();
            return;
        }

        if (event === "dialRotate" && action === `${pluginId}.dial`) {
            const ticks = payload?.ticks;
            if (Number.isSafeInteger(ticks) && ticks !== 0) {
                stopHold();
                supersedeVolume(Math.sign(ticks));
                enqueue(Math.max(-10, Math.min(10, ticks)), context);
            }
            return;
        }
        if (event !== "keyDown") return;

        const key = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        if (key === "dim") {
            if (dimPressed.has(context)) return;
            if (!payload?.isInMultiAction) dimPressed.add(context);
            stopHold();
            supersedeVolume();
            enqueue("dim", context).then((result) => {
                if (result === undefined && dimKeys.size) enqueue("read-dim", context);
            });
            return;
        }
        if (key !== "up" && key !== "down" && key !== "mute") return;
        if (pulses.has(context)) return;
        if (!payload?.isInMultiAction && typeof context === "string") startPulse(context, device, key);

        if (key === "mute") {
            stopHold();
            supersedeVolume();
            if (active?.command === "dim") active.controller.abort();
            enqueue("mute", context);
        } else {
            stopHold();
            supersedeVolume(key === "up" ? 1 : -1);
            const press = { context, device, direction: key, startedAt: performance.now() };
            if (!payload?.isInMultiAction) held = press;
            enqueue(key, context).then((result) => {
                if (result !== undefined) {
                    const elapsed = performance.now() - press.startedAt;
                    scheduleRepeat(press, Math.max(0, holdDelayMs + repeatIntervalsMs[key] - elapsed));
                }
            });
        }
    });
}
