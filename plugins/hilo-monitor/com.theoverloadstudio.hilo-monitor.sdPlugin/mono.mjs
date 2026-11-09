import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sources = 32;
const gains = 64;
const unity = 24;
const off = 216;
export const defaultMonoTrim = 6;

function decode(hex) {
    if (typeof hex !== "string" || !/^[0-9a-f]{144}$/.test(hex)) return;
    const bytes = Buffer.from(hex, "hex");
    if (bytes.subarray(0, gains).every(value => value >= unity && value <= off)) return bytes;
}

export function foldToLeft(stereo, trimDb = defaultMonoTrim) {
    const original = decode(stereo);
    if (!original) throw new Error("Invalid Monitor Out routing.");
    const target = Buffer.from(original);
    const trim = Number.isFinite(trimDb) ? Math.max(0, Math.min(24, trimDb)) : defaultMonoTrim;
    const attenuation = Math.pow(10, -trim / 20) / 2;
    target.fill(0xff, gains);
    for (let source = 0; source < sources; source++) {
        const maskByte = gains + (source >> 3);
        const mask = 1 << (source & 7);
        const contribution = (gain, mute) => gain === off || (mute & mask)
            ? 0 : Math.pow(10, -(gain - unity) / 40);
        const left = contribution(original[source], original[maskByte]);
        const right = contribution(original[sources + source], original[maskByte + 4]);
        const sum = (left + right) * attenuation;
        const encoded = sum > 0 ? Math.ceil(unity - 40 * Math.log10(sum) - 1e-9) : off;
        target[source] = Math.min(off, Math.max(unity, encoded));
        if (target[source] < off) target[maskByte] &= ~mask;
    }
    return target.toString("hex");
}

function isPartial(current, stereo, mono) {
    const original = decode(stereo), target = decode(mono);
    return decode(current).every((value, i) => value === original[i] || value === target[i] ||
        (i >= gains && value === (original[i] | target[i])));
}

export function createMono(run, stateFile) {
    async function save(state) {
        const temp = stateFile + ".tmp";
        await mkdir(dirname(stateFile), { recursive: true });
        try {
            await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
            await rename(temp, stateFile);
        } finally {
            await rm(temp, { force: true });
        }
    }

    return async (toggle, signal, trimDb) => {
        let state;
        try {
            const saved = JSON.parse(await readFile(stateFile, "utf8"));
            if (decode(saved?.stereo) && decode(saved?.mono) &&
                ["applying", "on", "restoring"].includes(saved.phase)) state = saved;
        } catch (error) {
            if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
        }
        if (!toggle && !state) return "Mono Off";
        const current = await run(["read-route"], signal);
        if (!decode(current)) throw new Error("Cannot read Monitor Out routing.");
        const active = state && current === state.mono;
        if (!toggle) return active ? "Mono On" : "Mono Off";

        const partial = state && state.phase !== "on" && isPartial(current, state.stereo, state.mono);
        if (active || (partial && state.phase === "restoring" && current !== state.stereo)) {
            await save({ ...state, phase: "restoring" });
            if (await run(["set-route", current, state.stereo], signal) !== state.stereo) {
                throw new Error("The Hilo did not confirm stereo routing.");
            }
            await rm(stateFile, { force: true });
            return "Mono Off";
        }
        if (state && current !== state.stereo && !partial) {
            throw new Error("Monitor Out routing changed outside the plugin; the saved stereo mix was left untouched.");
        }
        if (!state || current === state.stereo) {
            const mono = foldToLeft(current, trimDb);
            if (mono === current) return "Mono Off";
            state = { stereo: current, mono };
        }
        await save({ ...state, phase: "applying" });
        if (await run(["set-route", current, state.mono], signal) !== state.mono) {
            throw new Error("The Hilo did not confirm mono routing.");
        }
        await save({ ...state, phase: "on" });
        return "Mono On";
    };
}
