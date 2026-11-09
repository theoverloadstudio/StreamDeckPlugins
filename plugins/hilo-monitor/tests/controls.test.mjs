import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { attachMonitorActions } from "../com.theoverloadstudio.hilo-monitor.sdPlugin/actions.mjs";

function harness(t, handle = async () => "ok") {
    const socket = new EventTarget();
    socket.readyState = WebSocket.OPEN;
    socket.send = () => {};
    const calls = [];
    const faults = [];
    let running = false;
    attachMonitorActions(socket, {}, async (command, signal) => {
        assert.equal(running, false, "hardware calls must not overlap");
        running = true;
        calls.push({ command, signal });
        try { return await handle(command, signal); }
        finally { running = false; }
    }, error => faults.push(error));
    t.after(() => socket.dispatchEvent(new Event("close")));
    const event = (event, key) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        event, action: "com.theoverloadstudio.hilo-monitor." + key, context: key, device: "test",
    }) }));
    const tap = key => { event("keyDown", key); event("keyUp", key); };
    return { calls, faults, event, tap };
}

test("a quick tap issues one step on release; releasing a hold cancels its in-flight step", async t => {
    const { calls, faults, event } = harness(t, async (command, signal) => {
        if (command === "hold-down") await pause(1000, undefined, { signal });
        return "ok";
    });
    event("keyDown", "down");
    await pause(30);
    assert.equal(calls.length, 0);
    event("keyUp", "down");
    await pause(10);
    assert.deepEqual(calls.map(x => x.command), ["down"]);
    event("keyDown", "down");
    await pause(265);
    assert.deepEqual(calls.map(x => x.command), ["down", "hold-down"]);
    event("keyUp", "down");
    await pause(65);
    assert.equal(calls[1].signal.aborted, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(faults, []);
});

test("Mute discards earlier Up input and a second Mute cancels an in-flight unmute", async t => {
    const { calls, faults, event, tap } = harness(t, async (command, signal) => {
        if (command === "mute") await pause(1000, undefined, { signal });
        return "ok";
    });
    event("keyDown", "up");
    tap("mute");
    event("keyUp", "up");
    await pause(10);
    assert.deepEqual(calls.map(x => x.command), ["mute"]);
    tap("up");
    tap("mute");
    await pause(30);
    assert.equal(calls[0].signal.aborted, true);
    assert.deepEqual(calls.map(x => x.command), ["mute", "force-mute"]);
    tap("up");
    await pause(10);
    assert.deepEqual(calls.map(x => x.command), ["mute", "force-mute", "up"]);
    assert.deepEqual(faults, []);
});
