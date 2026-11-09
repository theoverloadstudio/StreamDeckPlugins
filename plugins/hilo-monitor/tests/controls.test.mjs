import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import { attachMonitorActions } from "../com.theoverloadstudio.hilo-monitor.sdPlugin/actions.mjs";

function harness(t, handle = async () => "ok") {
    const socket = new EventTarget();
    socket.readyState = WebSocket.OPEN;
    const sent = [];
    socket.send = message => sent.push(JSON.parse(message));
    const calls = [];
    const faults = [];
    let running = false;
    attachMonitorActions(socket, {}, async (command, signal, _trim, tiers, onGain, output, dimTarget) => {
        assert.equal(running, false, "hardware calls must not overlap");
        running = true;
        calls.push({ command, signal, tiers, output, dimTarget });
        try { return await handle(command, signal, onGain, output, dimTarget); }
        finally { running = false; }
    }, error => faults.push(error));
    t.after(() => socket.dispatchEvent(new Event("close")));
    const event = (event, key, payload) => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
        event, action: "com.theoverloadstudio.hilo-monitor." + key, context: key, device: "test", payload,
    }) }));
    const tap = key => { event("keyDown", key); event("keyUp", key); };
    return { calls, faults, event, tap, sent };
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

test("rapid taps accelerate, coalesce into one bounded batch, and reset after a pause", async t => {
    let finishFirst;
    const first = new Promise(resolve => { finishFirst = resolve; });
    let count = 0;
    const { calls, tap } = harness(t, async () => ++count === 1 ? first : "ok");
    tap("up");
    await pause(5);
    tap("up");
    tap("up");
    tap("up");
    assert.deepEqual(calls.map(x => [x.command, x.tiers]), [["up", [1]]]);
    finishFirst("ok");
    await pause(15);
    assert.deepEqual(calls.map(x => [x.command, x.tiers]), [["up", [1]], ["up", [2, 3]]]);
    await pause(300);
    tap("up");
    await pause(5);
    tap("up");
    await pause(5);
    tap("down");
    await pause(5);
    assert.deepEqual(calls.slice(-3).map(x => [x.command, x.tiers]),
        [["up", [1]], ["up", [2]], ["down", [1]]]);
});

test("a rapid Up burst never replays after Mute", async t => {
    const { calls, tap } = harness(t, async (command, signal) => {
        if (command === "up") await pause(1000, undefined, { signal });
        return "ok";
    });
    tap("up");
    await pause(5);
    tap("up");
    tap("up");
    tap("mute");
    await pause(15);
    assert.equal(calls[0].signal.aborted, true);
    assert.deepEqual(calls.map(x => x.command), ["up", "mute"]);
});

async function until(predicate) {
    const deadline = performance.now() + 1500;
    while (performance.now() < deadline) {
        if (predicate()) return;
        await pause(10);
    }
    assert.ok(predicate(), "Expected key display update");
}

test("visible keys show the verified Hilo level, external mute changes and disconnect", async t => {
    let status = "STATUS 147 0";
    const { sent, event, calls } = harness(t, async (command, _signal, onGain) => {
        if (command === "read-status") {
            if (!status) throw new Error("Disconnected");
            return status;
        }
        if (command === "read-dim") return "Dim On";
        if (command === 2) onGain(151);
        return "ok";
    });
    const image = (key, fragment) => sent.some(x => x.context === key && x.event === "setImage" &&
        decodeURIComponent(x.payload.image.slice("data:image/svg+xml,".length)).includes(fragment));
    event("willAppear", "dim");
    event("willAppear", "mute");
    event("willAppear", "up");
    event("willAppear", "down");
    await until(() => image("dim", 'aria-label="-22.5 dB"') && image("mute", ">ON</text>") &&
        image("up", 'width="38.28"') && image("down", 'width="38.28"'));
    assert.ok(image("dim", ">DIM ON</text>") && image("dim", "#efbd66"));
    assert.ok(sent.some(x => x.context === "dim" && x.event === "setState" && x.payload.state === 1));
    status = "STATUS 151 3";
    event("dialRotate", "dial", { ticks: 2 });
    await until(() => image("dim", 'aria-label="-20.5 dB"') && image("mute", ">MUTED</text>") &&
        image("up", 'width="39.32"') && image("down", 'width="39.32"'));
    assert.ok(image("mute", "#a83c29"));
    sent.length = 0;
    status = undefined;
    await until(() => image("dim", "No level available") && image("mute", ">NO LINK</text>"));
    event("willDisappear", "dim");
    event("willDisappear", "mute");
    event("willDisappear", "up");
    event("willDisappear", "down");
    const count = calls.length;
    await pause(720);
    assert.equal(calls.length, count, "no status polling with displays hidden");
});

test("headphone keys use their own hardware state and commands", async t => {
    const { sent, calls, tap, event } = harness(t, async (command, _signal, onGain, output) => {
        if (command === "read-status") return output === "phones" ? "STATUS 96 0" : "STATUS 144 3";
        if (command === "mute") return "Muted";
        onGain?.(command === "down" ? 92 : 100);
        return "ok";
    });
    const hasImage = (key, fragment) => sent.some(x => x.context === key && x.event === "setImage" &&
        decodeURIComponent(x.payload.image.slice("data:image/svg+xml,".length)).includes(fragment));
    event("willAppear", "up");
    event("willAppear", "phones-up");
    event("willAppear", "phones-mute");
    await until(() => hasImage("up", 'width="37.50"') && hasImage("phones-up", 'width="25.00"') &&
        hasImage("phones-mute", ">ON</text>"));
    tap("phones-up");
    await until(() => hasImage("phones-up", 'width="26.04"'));
    assert.equal(hasImage("up", 'width="26.04"'), false);
    tap("phones-down");
    await until(() => hasImage("phones-up", 'width="23.96"'));
    tap("phones-mute");
    await until(() => hasImage("phones-mute", ">MUTED</text>"));
    assert.deepEqual(calls.filter(x => x.command !== "read-status").map(x => [x.command, x.output]),
        [["up", "phones"], ["down", "phones"], ["mute", "phones"]]);
});

test("a hardware status poll yields immediately to a button press", async t => {
    const { calls, tap, event } = harness(t, async (command, signal) => {
        if (command === "read-status") await pause(1000, undefined, { signal });
        return command === "mute" ? "Muted" : "ok";
    });
    event("willAppear", "mute");
    await until(() => calls.length === 1);
    tap("mute");
    await until(() => calls.some(x => x.command === "mute"));
    assert.equal(calls[0].command, "read-status");
    assert.equal(calls[0].signal.aborted, true);
});

test("quick Dim presses reverse the running fade without relying on keyUp", async t => {
    const { calls, sent, event } = harness(t, async (command, signal, _gain, _output, target) => {
        if (command === "read-dim") return "Dim Off";
        if (command === "read-status") return "STATUS 119 0";
        if (target === "on") await pause(1000, undefined, { signal });
        return target === "off" ? "Dim Off" : "Dim On";
    });
    const labels = text => sent.some(item => item.event === "setImage" && item.context === "dim" &&
        decodeURIComponent(item.payload.image.slice("data:image/svg+xml,".length)).includes(">" + text + "</text>"));
    event("willAppear", "dim");
    event("keyDown", "dim");
    await until(() => calls.some(call => call.dimTarget === "on"));
    assert.ok(labels("DIMMING"));
    sent.length = 0;
    event("keyDown", "dim");
    await until(() => labels("DIM"));
    assert.ok(labels("RESTORE"));
    assert.deepEqual(calls.filter(call => call.command === "dim").map(call => [call.dimTarget, call.signal.aborted]),
        [["on", true], ["off", false]]);
});

test("only the latest Dim intent runs when several presses arrive before a fade completes", async t => {
    const { calls, sent, event, tap } = harness(t, async (command, signal, _gain, _output, target) => {
        if (command === "read-dim") return "Dim Off";
        if (command === "read-status") return "STATUS 119 0";
        await pause(60, undefined, { signal });
        return target === "on" ? "Dim On" : "Dim Off";
    });
    event("willAppear", "dim");
    tap("dim");
    await until(() => calls.some(call => call.dimTarget === "on"));
    tap("dim");
    tap("dim");
    tap("dim");
    await until(() => sent.some(item => item.event === "setImage" && item.context === "dim" &&
        decodeURIComponent(item.payload.image.slice("data:image/svg+xml,".length)).includes(">DIM</text>") &&
        calls.some(call => call.dimTarget === "off")));
    assert.deepEqual(calls.filter(call => call.command === "dim").map(call => call.dimTarget), ["on", "off"]);
});
