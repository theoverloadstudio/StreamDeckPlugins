const pluginId = "com.theoverloadstudio.hilo-monitor";

export function monitorSteps(message) {
    if (message.event === "keyDown") {
        switch (message.action) {
            case `${pluginId}.up`:
                return 1;
            case `${pluginId}.down`:
                return -1;
        }
    }

    if (message.event === "dialRotate" && message.action === `${pluginId}.dial`) {
        const ticks = message.payload?.ticks;
        if (Number.isSafeInteger(ticks)) {
            return ticks;
        }
    }

    return 0;
}

export function attachMonitorActions(socket, registration, adjustMonitorVolume, reportError) {
    let pending = Promise.resolve();

    socket.addEventListener("open", () => {
        socket.send(JSON.stringify(registration));
    });

    socket.addEventListener("message", ({ data }) => {
        const message = JSON.parse(data);
        const steps = monitorSteps(message);
        if (steps === 0) {
            return;
        }

        // Dial and key events can arrive while a previous adjustment is in flight.
        pending = pending
            .then(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    return adjustMonitorVolume(Math.max(-10, Math.min(10, steps)));
                }
            })
            .catch((error) => {
                reportError(error);
                if (socket.readyState === WebSocket.OPEN && typeof message.context === "string") {
                    socket.send(JSON.stringify({ event: "showAlert", context: message.context }));
                }
            });
    });
}
