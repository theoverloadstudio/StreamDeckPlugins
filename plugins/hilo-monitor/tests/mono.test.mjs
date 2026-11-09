import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMono, foldToLeft } from "../com.theoverloadstudio.hilo-monitor.sdPlugin/mono.mjs";

function route() {
    const stereo = Buffer.alloc(72, 216);
    stereo.fill(255, 64);
    stereo[0] = stereo[32 + 1] = 24;
    stereo[2] = stereo[32 + 2] = 36; // Source 2 has equal gain on both sides.
    stereo[3] = stereo[32 + 3] = 24; // Source 3 is muted in both.
    stereo[64] &= ~0b0101;
    stereo[68] &= ~0b0110;
    return stereo;
}

test("Mono averages the existing mix, respects source mutes and silences all right routes", () => {
    const target = Buffer.from(foldToLeft(route().toString("hex"), 6), "hex");
    assert.deepEqual([...target.subarray(0, 4)], [49, 49, 48, 216]);
    assert.equal(target[64] & 15, 8);
    assert.deepEqual([...target.subarray(68)], [255, 255, 255, 255]);
});

test("Mono restores the exact stereo routing after restarting and refuses to overwrite outside edits", async t => {
    const dir = await mkdtemp(join(tmpdir(), "hilo-mono-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const state = join(dir, "mono.json");
    const original = route().toString("hex");
    let current = original;
    let writes = 0;
    const run = async ([cmd, expected, target]) => {
        if (cmd === "read-route") return current;
        assert.equal(cmd, "set-route");
        assert.equal(expected, current);
        writes++;
        return current = target;
    };
    const signal = new AbortController().signal;
    const mono = createMono(run, state);
    assert.equal(await mono(true, signal, 6), "Mono On");
    assert.equal(await createMono(run, state)(true, signal), "Mono Off");
    assert.equal(current, original);
    assert.equal(await mono(true, signal), "Mono On");
    current = "33" + current.slice(2);
    await assert.rejects(mono(true, signal), /changed outside/);
    assert.equal(writes, 3);
});
