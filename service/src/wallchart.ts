import { Resvg } from "@resvg/resvg-js";
import { createHash } from "node:crypto";

/**
 * The living wall chart — the artifact the group actually shares. Drawn the
 * way your mate with the good handwriting would do it on the back of a
 * pizza box: wobbly ink lines, tombstones for the fallen, tally marks for
 * rounds, one red accent. All SVG paths are jittered with a PRNG seeded by
 * lobby + round so every render of the same state is identical.
 */

export interface ChartPlayer {
  name: string;
  alive: boolean;
  diedRound?: number;
  fatalPick?: string;
  diedMinute?: number;
  /** landed kiricocho count (credited jinxes) */
  jinxCredits: number;
  /** name of the player whose jinx killed them, if any */
  jinxedBy?: string;
  isWinner?: boolean;
}

export interface ChartData {
  fixture: string;
  lobbyId: string;
  roundNo: number;
  demo: boolean;
  players: ChartPlayer[];
  crowned?: boolean;
}

const INK = "#2b2b30";
const FADED = "#6d6a63";
const ACCENT = "#b3392e";
const PAPER = "#f4ecdc";

// --- deterministic wobble ---------------------------------------------------

function rng(seed: string): () => number {
  let s = createHash("sha256").update(seed).digest().readUInt32BE(0);
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const j = (r: () => number, amt = 1.6) => (r() - 0.5) * 2 * amt;

/** A line that was clearly drawn by a hand, not a plotter. */
function handLine(x1: number, y1: number, x2: number, y2: number, r: () => number): string {
  const mx = (x1 + x2) / 2 + j(r), my = (y1 + y2) / 2 + j(r);
  return `M ${x1 + j(r)} ${y1 + j(r)} Q ${mx} ${my} ${x2 + j(r)} ${y2 + j(r)}`;
}

function handRect(x: number, y: number, w: number, h: number, r: () => number): string {
  return [
    handLine(x, y, x + w, y, r),
    handLine(x + w, y, x + w, y + h, r),
    handLine(x + w, y + h, x, y + h, r),
    handLine(x, y + h, x, y, r),
  ].join(" ");
}

/** Round-topped tombstone outline. */
function tombstone(x: number, y: number, w: number, h: number, r: () => number): string {
  const rr = w / 2;
  return (
    `M ${x + j(r)} ${y + h + j(r)} ` +
    `L ${x + j(r)} ${y + rr + j(r)} ` +
    `Q ${x + j(r)} ${y + j(r)} ${x + rr + j(r)} ${y + j(r)} ` +
    `Q ${x + w + j(r)} ${y + j(r)} ${x + w + j(r)} ${y + rr + j(r)} ` +
    `L ${x + w + j(r)} ${y + h + j(r)} Z`
  );
}

/** Tally marks: groups of four + the diagonal fifth. */
function tally(x: number, y: number, count: number, r: () => number, stroke = INK): string {
  const parts: string[] = [];
  let cx = x;
  for (let g = 0; g < Math.floor(count / 5); g++) {
    for (let i = 0; i < 4; i++)
      parts.push(path(handLine(cx + i * 7, y, cx + i * 7 + j(r, 2), y + 20, r), stroke, 2.4));
    parts.push(path(handLine(cx - 4, y + 16, cx + 26, y + 3, r), stroke, 2.4));
    cx += 40;
  }
  for (let i = 0; i < count % 5; i++)
    parts.push(path(handLine(cx + i * 7, y, cx + i * 7 + j(r, 2), y + 20, r), stroke, 2.4));
  return parts.join("");
}

function path(d: string, stroke = INK, width = 2.2): string {
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- renders ----------------------------------------------------------------

const FONT_FILES = [
  new URL("../assets/fonts/PatrickHand-Regular.ttf", import.meta.url).pathname,
  new URL("../assets/fonts/GochiHand-Regular.ttf", import.meta.url).pathname,
  new URL("../assets/fonts/Caveat.ttf", import.meta.url).pathname,
];

function toPng(svg: string, width: number): Buffer {
  const resvg = new Resvg(svg, {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "Patrick Hand" },
    fitTo: { mode: "width", value: width },
  });
  return Buffer.from(resvg.render().asPng());
}

/** Paper + margin scuffs shared by both cards. */
function paper(w: number, h: number, r: () => number): string {
  const scuffs: string[] = [];
  for (let i = 0; i < 7; i++) {
    const x = r() * w, y = r() * h;
    scuffs.push(
      `<circle cx="${x}" cy="${y}" r="${0.6 + r() * 1.2}" fill="${INK}" opacity="${0.04 + r() * 0.05}"/>`
    );
  }
  return `<rect width="${w}" height="${h}" fill="${PAPER}"/>` + scuffs.join("");
}

export function wallChartSvg(data: ChartData): string {
  const r = rng(`${data.lobbyId}:${data.roundNo}`);
  const W = 720;
  const rowH = 96;
  const top = 168;
  const H = top + data.players.length * rowH + 96;

  const rows = data.players
    .map((p, i) => {
      const y = top + i * rowH;
      if (!p.alive) {
        const deadBits = [
          `<path d="${tombstone(34, y + 6, 64, 66, r)}" fill="#e7dcc6" stroke="${FADED}" stroke-width="2.4"/>`,
          `<text x="66" y="${y + 34}" font-size="20" fill="${FADED}" text-anchor="middle" font-family="Gochi Hand">R.I.P</text>`,
          `<text x="66" y="${y + 58}" font-size="15" fill="${FADED}" text-anchor="middle" font-family="Gochi Hand">R${p.diedRound}</text>`,
          `<text x="120" y="${y + 34}" font-size="27" fill="${FADED}" font-family="Patrick Hand" style="text-decoration:line-through">${esc(p.name)}</text>`,
          `<text x="120" y="${y + 62}" font-size="18" fill="${FADED}" font-family="Caveat">${
            p.fatalPick ? `fatal pick: “${esc(p.fatalPick)}”, ${p.diedMinute}'` : `went silent, ${p.diedMinute}'`
          }</text>`,
        ];
        if (p.jinxedBy) {
          deadBits.push(
            `<text x="${W - 42}" y="${y + 40}" font-size="17" fill="${ACCENT}" text-anchor="end" font-family="Caveat">kiricocho — ${esc(p.jinxedBy)}</text>`
          );
        }
        return deadBits.join("");
      }
      const aliveBits = [
        path(handRect(30, y + 4, W - 72, 66, r), p.isWinner ? ACCENT : INK, p.isWinner ? 3 : 2.2),
        `<text x="52" y="${y + 46}" font-size="29" fill="${INK}" font-family="Patrick Hand">${esc(p.name)}</text>`,
      ];
      if (p.isWinner) {
        aliveBits.push(
          `<text x="${W - 60}" y="${y + 46}" font-size="24" fill="${ACCENT}" text-anchor="end" font-family="Gochi Hand">LAST FAN STANDING</text>`
        );
        // hand-drawn crown
        const cx = 30 + 8;
        aliveBits.push(
          path(
            `M ${cx - 14} ${y - 2} L ${cx - 10} ${y - 16} L ${cx - 4} ${y - 5} L ${cx + 1} ${y - 18} L ${cx + 6} ${y - 5} L ${cx + 12} ${y - 16} L ${cx + 16} ${y - 2} Z`,
            ACCENT,
            2.4
          )
        );
      } else {
        aliveBits.push(
          `<text x="${W - 60}" y="${y + 46}" font-size="20" fill="${INK}" text-anchor="end" font-family="Caveat">still standing</text>`
        );
      }
      if (p.jinxCredits > 0) {
        aliveBits.push(
          `<text x="52" y="${y + 66}" font-size="16" fill="${ACCENT}" font-family="Caveat">${"†".repeat(p.jinxCredits)} kiricocho landed</text>`
        );
      }
      return aliveBits.join("");
    })
    .join("");

  const alive = data.players.filter((p) => p.alive).length;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${paper(W, H, r)}
  <text x="36" y="62" font-size="44" fill="${INK}" font-family="Gochi Hand">LAST FAN STANDING</text>
  ${path(handLine(36, 76, W - 250, 78, r), ACCENT, 3)}
  <text x="36" y="112" font-size="24" fill="${INK}" font-family="Patrick Hand">${esc(data.fixture)}${data.demo ? "  ·  DEMO" : ""}</text>
  <text x="36" y="142" font-size="19" fill="${FADED}" font-family="Caveat">round ${data.roundNo} · ${alive} of ${data.players.length} alive · every pick signed &amp; anchored</text>
  ${tally(W - 200, 96, Math.min(data.roundNo, 15), r, ACCENT)}
  ${rows}
  <text x="36" y="${H - 40}" font-size="17" fill="${FADED}" font-family="Caveat">picks are ed25519-signed by each fan's own key · round roots + survivor cert live in the Memo trail on Solana devnet</text>
</svg>`;
  return svg;
}

export function renderWallChart(data: ChartData): Buffer {
  return toPng(wallChartSvg(data), 1080);
}

export function tombstoneCardSvg(opts: {
  lobbyId: string;
  roundN: number;
  name: string;
  fatalPick?: string;
  minute: number;
  jinxedBy?: string;
}): string {
  const r = rng(`${opts.lobbyId}:${opts.roundN}:${opts.name}`);
  const W = 560, H = 560;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${paper(W, H, r)}
  <path d="${tombstone(150, 90, 260, 330, r)}" fill="#e7dcc6" stroke="${INK}" stroke-width="3.4"/>
  ${path(handLine(120, 424, 440, 428, r), INK, 3)}
  ${path(handLine(100, 436, 460, 440, r), FADED, 2.2)}
  <text x="280" y="170" font-size="40" fill="${INK}" text-anchor="middle" font-family="Gochi Hand">R.I.P</text>
  <text x="280" y="230" font-size="36" fill="${INK}" text-anchor="middle" font-family="Patrick Hand">${esc(opts.name)}</text>
  ${path(handLine(200, 250, 360, 252, r), FADED, 2)}
  <text x="280" y="296" font-size="22" fill="${FADED}" text-anchor="middle" font-family="Caveat">${
    opts.fatalPick ? `died backing` : `died in silence`
  }</text>
  ${opts.fatalPick ? `<text x="280" y="330" font-size="25" fill="${ACCENT}" text-anchor="middle" font-family="Caveat">“${esc(opts.fatalPick)}”</text>` : ""}
  <text x="280" y="378" font-size="22" fill="${FADED}" text-anchor="middle" font-family="Gochi Hand">minute ${opts.minute}</text>
  ${opts.jinxedBy ? `<text x="280" y="486" font-size="22" fill="${ACCENT}" text-anchor="middle" font-family="Caveat">kiricocho by ${esc(opts.jinxedBy)} †</text>` : ""}
  <text x="280" y="${H - 26}" font-size="16" fill="${FADED}" text-anchor="middle" font-family="Caveat">out of the pool · ghosts may haunt once</text>
</svg>`;
}

export function renderTombstoneCard(opts: Parameters<typeof tombstoneCardSvg>[0]): Buffer {
  return toPng(tombstoneCardSvg(opts), 840);
}
