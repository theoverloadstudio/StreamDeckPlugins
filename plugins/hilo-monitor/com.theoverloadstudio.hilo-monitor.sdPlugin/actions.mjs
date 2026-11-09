const pluginId = "com.theoverloadstudio.hilo-monitor";
const holdDelayMs = 200;
// The helper moves 1.5 dB per repeat, covering 71.5 dB in about 2.3 seconds.
const repeatIntervalMs = 48;

export function attachMonitorActions(socket, registration, adjust, reportError) {
    let pending = Promise.resolve();
    let held;

    function stopHold() {
        clearTimeout(held?.timer);
        held = undefined;
    }

    function enqueue(command, context, isCurrent = () => true) {
        const job = pending.then(() => {
            if (socket.readyState === WebSocket.OPEN && isCurrent()) {
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
    socket.addEventListener("close", stopHold);
    socket.addEventListener("message", ({ data }) => {
        const { event, action, context, device, payload } = JSON.parse(data);
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

        if (action === `${pluginId}.mute`) {
            stopHold();
            enqueue("mute", context);
        } else if (action === `${pluginId}.up` || action === `${pluginId}.down`) {
            if (held?.context === context) return;

            stopHold();
            const direction = action === `${pluginId}.up` ? "up" : "down";
            const press = { context, device, direction };
            if (!payload?.isInMultiAction) held = press;
            enqueue(direction, context).then((result) => {
                if (result !== undefined) scheduleRepeat(press, holdDelayMs + repeatIntervalMs);
            });
        }
    });
}
