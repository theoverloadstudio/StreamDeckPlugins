const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 125;
const repeatIntervalMs = 37;
const pulseIntervalMs = 180;

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;
    let volumeGeneration = 0;
    const pulses = new Map();

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
        held = undefined;
    }

    function enqueue(command, context, isCurrent = () => true) {
        const generation = volumeGeneration;
        const job = pending.then(() => {
            if (socket.readyState === WebSocket.OPEN && isCurrent() &&
                (command === "mute" || generation === volumeGeneration)) {
                return adjust(command);
            }
        });
        pending = job.catch((error) => {
            if (held?.context === context) stopHold();
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
                () => held === press,
            );
            if (held === press && result !== undefined && result !== "Limit") {
                const elapsed = performance.now() - startedAt;
                scheduleRepeat(press, Math.max(0, repeatIntervalMs - elapsed));
            }
        }, delay);
    }

    socket.addEventListener("open", () => socket.send(JSON.stringify(registration)));
    socket.addEventListener("close", () => {
        stopHold();
        for (const context of pulses.keys()) stopPulse(context);
    });
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
        if (event === "keyUp" || event === "willDisappear") stopPulse(context);
        if (event === "deviceDidDisconnect") {
            for (const [key, pulse] of pulses) {
                if (pulse.device === device) stopPulse(key);
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
                enqueue(Math.max(-10, Math.min(10, ticks)), context);
            }
            return;
        }
        if (event !== "keyDown") return;

        const key = action?.startsWith(`${pluginId}.`) ? action.slice(pluginId.length + 1) : "";
        if (key !== "up" && key !== "down" && key !== "mute") return;
        if (pulses.has(context)) return;
        if (!payload?.isInMultiAction && typeof context === "string") startPulse(context, device, key);

        if (key === "mute") {
            stopHold();
            volumeGeneration++;
            enqueue("mute", context);
        } else {
            stopHold();
            const press = { context, device, direction: key };
            if (!payload?.isInMultiAction) held = press;
            enqueue(key, context).then((result) => {
                if (result !== undefined) scheduleRepeat(press, holdDelayMs + repeatIntervalMs);
            });
        }
    });
}
