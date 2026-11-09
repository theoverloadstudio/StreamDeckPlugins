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
    return async (toggle, signal) => {
        let normal;
        try {
            const saved = JSON.parse(await readFile(stateFile, "utf8"));
            if (validLevels(saved)) normal = saved;
        } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        if (!toggle && !normal) return "Dim Off";

        const current = (await run(["read-digital"], signal)).split(" ").map(Number);
        if (!validLevels(current)) throw new Error("Cannot read the Monitor Out digital levels.");
        const on = normal && !equal(normal, current) && equal(dimmed(normal), current);
        if (!toggle) return on ? "Dim On" : "Dim Off";

        if (on) {
            await run(["set-digital", ...current, ...normal], signal);
            await rm(stateFile, { force: true });
            return "Dim Off";
        }
        if (normal && !equal(normal, current)) {
            // The hardware changed outside this toggle, or a ramp stopped.
            // Discard the old restore level without raising either channel.
            await rm(stateFile, { force: true });
            throw new Error("Monitor Out digital levels changed. Press Dim again to use the current levels.");
        }
        const target = dimmed(current);
        if (equal(target, current)) throw new Error("Monitor Out digital level is already at its minimum.");
        signal.throwIfAborted();
        await mkdir(dirname(stateFile), { recursive: true });
        const temporary = stateFile + ".tmp";
        try {
            await writeFile(temporary, JSON.stringify(current), { mode: 0o600 });
            await rename(temporary, stateFile);
        } finally {
            await rm(temporary, { force: true });
        }
        await run(["set-digital", ...current, ...target], signal);
        return "Dim On";
    };
}
