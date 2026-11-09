import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createDim } from "../com.theoverloadstudio.hilo-monitor.sdPlugin/dim.mjs";

test("an interrupted 1 dB Dim step can be completed and then restored", async t => {
    const dir = await mkdtemp(join(tmpdir(), "hilo-dim-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let levels = [24, 28];
    let interrupt = true;
    const run = async ([command, ...args]) => {
        if (command === "read-digital") return levels.join(" ");
        assert.equal(command, "set-digital");
        const current = args.slice(0, 2);
        const target = args.slice(2);
        assert.deepEqual(current, levels);
        if (interrupt) {
            interrupt = false;
            levels[0] += 2;
            throw new Error("Interrupted during a pair");
        }
        levels = target;
        return levels.join(" ");
    };
    const dim = createDim(run, join(dir, "dim.json"));
    const signal = new AbortController().signal;
    await assert.rejects(dim(true, signal), /Interrupted/);
    assert.deepEqual(levels, [26, 28]);
    assert.equal(await dim(true, signal), "Dim On");
    assert.deepEqual(levels, [54, 58]);
    assert.equal(await dim(true, signal), "Dim Off");
    assert.deepEqual(levels, [24, 28]);
});

test("an explicit Off restores the original levels from a partially engaged fade", async t => {
    const dir = await mkdtemp(join(tmpdir(), "hilo-dim-reverse-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let levels = [24, 28];
    let interrupt = true;
    const run = async ([command, ...args]) => {
        if (command === "read-digital") return levels.join(" ");
        assert.equal(command, "set-digital");
        assert.deepEqual(args.slice(0, 2), levels);
        if (interrupt) {
            interrupt = false;
            levels = [36, 38];
            throw new Error("Interrupted during a pair");
        }
        levels = args.slice(2);
        return levels.join(" ");
    };
    const dim = createDim(run, join(dir, "dim.json"));
    const signal = new AbortController().signal;
    await assert.rejects(dim("on", signal), /Interrupted/);
    assert.equal(await dim(false, signal), "Dim On");
    assert.equal(await dim("off", signal), "Dim Off");
    assert.deepEqual(levels, [24, 28]);
    assert.equal(await dim(false, signal), "Dim Off");
});
