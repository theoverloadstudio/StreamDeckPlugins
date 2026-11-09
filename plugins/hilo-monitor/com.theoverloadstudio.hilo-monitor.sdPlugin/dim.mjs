import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const dimSteps = 30; // 15 dB in half-decibel digital steps.
const digitalFloor = 216;
const validLevels = (pair) => Array.isArray(pair) && pair.length === 2 &&
    pair.every(value => Number.isInteger(value) && value >= 24 && value <= digitalFloor);
const equal = (a, b) => a[0] === b[0] && a[1] === b[1];
const dimmed = (levels) => {
    const steps = Math.min(dimSteps, digitalFloor - Math.max(...levels));
    return levels.map(value => value + steps);
};

export function createDim(run, stateFile) {
    async function save(normal, phase) {
        await mkdir(dirname(stateFile), { recursive: true });
        const temporary = stateFile + ".tmp";
        try {
            await writeFile(temporary, JSON.stringify({ normal, phase }), { mode: 0o600 });
            await rename(temporary, stateFile);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    return async (toggle, signal) => {
        let normal, phase;
        try {
            const saved = JSON.parse(await readFile(stateFile, "utf8"));
            if (validLevels(saved)) {
                normal = saved;
                phase = "on";
            } else if (validLevels(saved?.normal) && ["applying", "on", "restoring"].includes(saved.phase)) {
                ({ normal, phase } = saved);
            }
        } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        if (!toggle && !normal) return "Dim Off";

        const current = (await run(["read-digital"], signal)).split(" ").map(Number);
        if (!validLevels(current)) throw new Error("Cannot read the Monitor Out digital levels.");
        const on = normal && !equal(normal, current) && equal(dimmed(normal), current);
        if (!toggle) return on ? "Dim On" : "Dim Off";

        if (on) {
            await save(normal, "restoring");
            await run(["set-digital", ...current, ...normal], signal);
            await rm(stateFile, { force: true });
            return "Dim Off";
        }
        if (normal && !equal(normal, current)) {
            const target = dimmed(normal);
            const offsets = current.map((value, channel) => value - normal[channel]);
            if (phase !== "on" && current.every((value, channel) => value >= normal[channel] && value <= target[channel]) &&
                Math.abs(offsets[0] - offsets[1]) <= 1) {
                // After interruption, finish dimming first. An explicit
                // second press can then bring both channels back up together.
                await save(normal, "applying");
                await run(["set-digital", ...current, ...target], signal);
                await save(normal, "on");
                return "Dim On";
            }
            // An unrelated hardware change must never restore an old level.
            await rm(stateFile, { force: true });
            throw new Error("Monitor Out digital levels changed. Press Dim again to use the current levels.");
        }
        const target = dimmed(current);
        if (equal(target, current)) throw new Error("Monitor Out digital level is already at its minimum.");
        signal.throwIfAborted();
        await save(current, "applying");
        await run(["set-digital", ...current, ...target], signal);
        await save(current, "on");
        return "Dim On";
    };
}
