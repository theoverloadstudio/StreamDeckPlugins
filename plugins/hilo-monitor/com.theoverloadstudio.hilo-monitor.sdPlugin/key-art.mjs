const ink = "#30281f";
const ivory = "#e9decc";
const accents = { up: "#587149", down: "#a35b31", amber: "#b27b36", red: "#a33926", neutral: "#867967" };

const digitPaths = [
    "M2 1h6l1 1v12l-1 1H2l-1-1V2z",
    "M5 3l2-2v14",
    "M1 2l1-1h6l1 1v5l-8 7v1h8",
    "M1 1h7l1 1v5l-1 1H5m3 0 1 1v5l-1 1H1",
    "M1 1v8h8M7 1v14",
    "M9 1H1v7h7l1 1v5l-1 1H1",
    "M9 1H2L1 2v12l1 1h6l1-1V9L8 8H1",
    "M1 1h8v2L4 15",
    "M2 1h6l1 1v5L8 8H2L1 7V2zM2 8l-1 1v5l1 1h6l1-1V9L8 8",
    "M9 8H2L1 7V2l1-1h6l1 1v12l-1 1H1",
];

function readout(gain) {
    if (gain === undefined) {
        return '<g aria-label="No level available"><path d="M28 37h16" stroke="#726353" stroke-width="2.4" stroke-linecap="round"/></g>';
    }
    if (gain === 0) return label("OFF", 43, 15, 1.1);
    const value = ((gain - 192) / 2).toFixed(1);
    const widths = [...value].map(character => character === "." ? 5 : character === "-" ? 10 : 12);
    const width = widths.reduce((sum, size) => sum + size, 0) - 2;
    let x = (72 - width) / 2;
    const digits = [...value].map((character, index) => {
        const path = character === "." ? "M1 14h.2" : character === "-" ? "M1 8h6" : digitPaths[Number(character)];
        const digit = `<path transform="translate(${x} 29)" d="${path}"/>`;
        x += widths[index];
        return digit;
    }).join("");
    return `<g aria-label="${value} dB" fill="none" stroke="${ink}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${digits}</g>`;
}

function label(text, y, size, spacing = 1, color = ink) {
    return `<text x="36" y="${y}" fill="${color}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${size}" font-weight="700" letter-spacing="${spacing}">${text}</text>`;
}

function lamp(x, y, color) {
    return `<circle cx="${x}" cy="${y}" r="4.1" fill="${color}" stroke="#493d30" stroke-opacity=".35" stroke-width=".7"/><path d="M${x - 2} ${y - 2}q2-1.5 4 0" fill="none" stroke="#fff7e4" opacity=".45" stroke-linecap="round"/>`;
}

function levelBar(gain, color) {
    // Follow the analog fader setting, independent of Mute and Dim.
    const level = gain === undefined ? 0 : gain / 192;
    const width = 50 * level;
    return `<g aria-label="Monitor Out level"><rect x="11" y="51" width="50" height="7" rx="3.5" fill="#b9a994"/>${width ? `<rect x="11" y="51" width="${width.toFixed(2)}" height="7" rx="${Math.min(3.5, width / 2)}" fill="${color}"/>` : ""}<path d="M21 52v5m10-5v5m10-5v5m10-5v5" stroke="${ivory}" opacity=".46" stroke-width=".75"/></g>`;
}

export function keySvg(key, { gain, active, muteBits, bright = false } = {}, size = 144) {
    let content;
    if (key === "dim") {
        content = label("DIM", 21, 10, 1.6) + lamp(56, 17, active ? accents.amber : "#b8a992") +
            readout(gain) + label("MON OUT · dB", 58, 6.3, .5, "#584a3d");
    } else if (key === "mute") {
        const states = [["LIVE", accents.up], ["L MUTED", accents.amber], ["R MUTED", accents.amber], ["MUTED", accents.red]];
        const [status, color] = states[muteBits] ?? ["NO LINK", accents.neutral];
        content = label("MUTE", 23, 10, 1.7) + lamp(36, 37, color) + label(status, 58, 8.7, .9, color);
    } else if (key === "mono") {
        content = label("MONO", 25, 10, 1.7) + lamp(36, 38, active ? accents.up : "#b8a992") +
            label("LEFT", 57, 8, 1);
    } else {
        const up = key === "up";
        const color = accents[key];
        const sign = up ? "M48 31h11m-5.5-5.5v11" : "M48 31h11";
        content = lamp(36, 17, color) +
            '<text x="13" y="36" fill="#30281f" font-family="Arial,sans-serif" font-size="14" font-weight="700" letter-spacing="1.2">VOL</text>' +
            `<path d="${sign}" fill="none" stroke="${ink}" stroke-width="2.25" stroke-linecap="round"/>` +
            levelBar(gain, color);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 72 72">
<defs><linearGradient id="face" x2=".14" y2="1" gradientUnits="objectBoundingBox"><stop stop-color="${bright ? "#fff9ed" : "#f3e9d8"}"/><stop offset=".62" stop-color="${ivory}"/><stop offset="1" stop-color="#d3c1a8"/></linearGradient></defs>
<rect x="1" y="3" width="70" height="68" rx="12" fill="#3d3328"/>
<rect x="1.5" y="1.5" width="69" height="67" rx="11" fill="#b6a38a" stroke="#fff5e4"/>
<rect x="4" y="4" width="64" height="62" rx="9" fill="url(#face)" stroke="#8f7d65" stroke-width=".8"/>
<path d="M10 10q2-3 6-3h39q4 0 6 3" fill="none" stroke="#fff8e9" stroke-width=".9" opacity=".72" stroke-linecap="round"/>
${content}
</svg>
`;
}

export function keyImage(key, state) {
    return "data:image/svg+xml," + encodeURIComponent(keySvg(key, state));
}
