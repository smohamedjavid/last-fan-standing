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

// --- graveyard reel ---------------------------------------------------------
//
// The full-time recap: one tall funeral programme. Every fallen fan gets a
// tombstone in the order they went, their fatal pick, and a graveside roast.
// The kiricocho jinxes are tallied, and the sole survivor is crowned with the
// certificate line. Same ink, same paper, same wobble as the wall chart — this
// is the artifact the group screenshots when the whistle blows.

export interface ReelTomb {
  name: string;
  round: number;
  minute: number;
  /** the fatal pick's label; undefined means they went silent */
  fatalPick?: string;
  /** one-line graveside roast in the pundit's template voice */
  roast: string;
  /** the jinxer whose kiricocho landed on them, if any */
  jinxedBy?: string;
}

export interface ReelCardData {
  fixture: string;
  lobbyId: string;
  demo: boolean;
  totalRounds: number;
  /** tombstones, already sorted into death order by the caller */
  tombs: ReelTomb[];
  jinxes: Array<{ jinxer: string; target: string; round: number; landed: boolean }>;
  /** survivor name(s); empty on a total wipeout */
  survivors: string[];
  /** short prefix of the survivor certificate hash */
  certHashPrefix?: string;
  /** whether the certificate is anchored in the Memo trail yet */
  anchored: boolean;
}

/** Break a roast into at most `maxLines` lines of ~`maxChars`, eliding the rest. */
function wrapWords(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if (`${cur} ${w}`.length <= maxChars) cur += ` ${w}`;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const used = lines.join(" ").length;
  if (lines.length === maxLines && used < words.join(" ").length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return lines.length ? lines : [""];
}

/** A crown, drawn by hand, base at `baseY`, peaks rising above it. */
function handCrown(cx: number, baseY: number, w: number, r: () => number): string {
  const h = w * 0.72;
  const x = cx - w / 2;
  const top = baseY - h;
  return path(
    `M ${x + j(r)} ${baseY + j(r)} ` +
      `L ${x + j(r)} ${top + h * 0.35 + j(r)} ` +
      `L ${x + w * 0.25 + j(r)} ${baseY - h * 0.2 + j(r)} ` +
      `L ${x + w * 0.5 + j(r)} ${top + j(r)} ` +
      `L ${x + w * 0.75 + j(r)} ${baseY - h * 0.2 + j(r)} ` +
      `L ${x + w + j(r)} ${top + h * 0.35 + j(r)} ` +
      `L ${x + w + j(r)} ${baseY + j(r)} Z`,
    ACCENT,
    3
  );
}

export function graveyardReelSvg(data: ReelCardData): string {
  const r = rng(`${data.lobbyId}:reel`);
  const W = 760;
  const LEFT = 40;

  // Pre-measure every tomb block so the canvas height is exact.
  const blocks = data.tombs.map((t) => {
    const roastLines = wrapWords(t.roast, 66, 2);
    const h = 74 + roastLines.length * 24 + (t.jinxedBy ? 22 : 0) + 14;
    return { tomb: t, roastLines, h: Math.max(h, 92) };
  });

  const headTop = 210;
  const tombsH = blocks.reduce((s, b) => s + b.h, 0);
  const jinxH = data.jinxes.length ? 78 + data.jinxes.length * 30 : 0;
  const boxH = 132;
  const H = headTop + tombsH + jinxH + 24 + boxH + 64;

  const parts: string[] = [paper(W, H, r)];

  // masthead
  parts.push(
    `<text x="${LEFT}" y="66" font-size="46" fill="${INK}" font-family="Gochi Hand">THE GRAVEYARD REEL</text>`
  );
  parts.push(path(handLine(LEFT, 82, W - 210, 84, r), ACCENT, 3));
  parts.push(
    `<text x="${LEFT}" y="116" font-size="25" fill="${INK}" font-family="Patrick Hand">FULL TIME · ${esc(
      data.fixture
    )}${data.demo ? "  ·  DEMO" : ""}</text>`
  );
  const funerals = data.tombs.length;
  parts.push(
    `<text x="${LEFT}" y="146" font-size="19" fill="${FADED}" font-family="Caveat">${funerals} funeral${
      funerals === 1 ? "" : "s"
    } · ${data.totalRounds} round${
      data.totalRounds === 1 ? "" : "s"
    } · every pick signed &amp; anchored before the whistle</text>`
  );
  parts.push(
    `<text x="${LEFT}" y="190" font-size="26" fill="${ACCENT}" font-family="Gochi Hand">THE FALLEN — in the order they went</text>`
  );

  // tombs, in death order
  let y = headTop;
  for (const b of blocks) {
    const t = b.tomb;
    parts.push(
      `<path d="${tombstone(LEFT, y + 4, 54, 58, r)}" fill="#e7dcc6" stroke="${FADED}" stroke-width="2.4"/>`
    );
    parts.push(
      `<text x="${LEFT + 27}" y="${y + 30}" font-size="17" fill="${FADED}" text-anchor="middle" font-family="Gochi Hand">R.I.P</text>`
    );
    parts.push(
      `<text x="${LEFT + 27}" y="${y + 50}" font-size="15" fill="${FADED}" text-anchor="middle" font-family="Gochi Hand">R${t.round}</text>`
    );
    const nx = LEFT + 76;
    parts.push(
      `<text x="${nx}" y="${y + 32}" font-size="30" fill="${INK}" font-family="Patrick Hand" style="text-decoration:line-through">${esc(
        t.name
      )}</text>`
    );
    const cause = t.fatalPick
      ? `died backing “${esc(t.fatalPick)}”, ${t.minute}'`
      : `went silent, ${t.minute}'`;
    parts.push(`<text x="${nx}" y="${y + 58}" font-size="19" fill="${FADED}" font-family="Caveat">${cause}</text>`);
    let ry = y + 84;
    for (const rl of b.roastLines) {
      parts.push(`<text x="${nx}" y="${ry}" font-size="18" fill="#4a463f" font-family="Caveat">${esc(rl)}</text>`);
      ry += 24;
    }
    if (t.jinxedBy) {
      parts.push(
        `<text x="${nx}" y="${ry}" font-size="17" fill="${ACCENT}" font-family="Caveat">† kiricocho — ${esc(
          t.jinxedBy
        )}</text>`
      );
    }
    parts.push(path(handLine(LEFT, y + b.h - 8, W - 40, y + b.h - 6, r), FADED, 1));
    y += b.h;
  }

  // kiricocho ledger
  if (data.jinxes.length) {
    y += 16;
    parts.push(path(handLine(LEFT, y, W - 40, y + 2, r), INK, 1.4));
    y += 32;
    parts.push(
      `<text x="${LEFT}" y="${y}" font-size="24" fill="${INK}" font-family="Gochi Hand">KIRICOCHO — the jinxes cast</text>`
    );
    y += 30;
    for (const jx of data.jinxes) {
      const color = jx.landed ? ACCENT : FADED;
      const mark = jx.landed ? "†" : "·";
      const verdict = jx.landed ? "landed" : "no effect";
      parts.push(
        `<text x="${LEFT}" y="${y}" font-size="20" fill="${color}" font-family="Caveat">${mark} ${esc(
          jx.jinxer
        )} cursed ${esc(jx.target)} (R${jx.round}) — ${verdict}</text>`
      );
      y += 30;
    }
  }

  // the crown, or the wipeout
  y += 24;
  const boxX = LEFT;
  const boxY = y;
  const boxW = W - 80;
  if (data.survivors.length) {
    parts.push(path(handRect(boxX, boxY, boxW, boxH, r), ACCENT, 3));
    parts.push(handCrown(boxX + 52, boxY + 34, 42, r));
    const sole = data.survivors.length === 1;
    parts.push(
      `<text x="${boxX + 96}" y="${boxY + 42}" font-size="30" fill="${ACCENT}" font-family="Gochi Hand">${
        sole ? "LAST FAN STANDING" : "CO-SURVIVORS"
      }</text>`
    );
    parts.push(
      `<text x="${boxX + 96}" y="${boxY + 78}" font-size="28" fill="${INK}" font-family="Patrick Hand">${esc(
        data.survivors.join(", ")
      )}</text>`
    );
    const certLine = data.certHashPrefix
      ? `survivor certificate ${esc(data.certHashPrefix)}… ${
          data.anchored ? "anchored on Solana devnet" : "issued"
        }`
      : `survivor certificate issued`;
    parts.push(`<text x="${boxX + 96}" y="${boxY + 108}" font-size="18" fill="${FADED}" font-family="Caveat">${certLine}</text>`);
  } else {
    parts.push(path(handRect(boxX, boxY, boxW, boxH, r), INK, 3));
    parts.push(
      `<text x="${boxX + 30}" y="${boxY + 50}" font-size="30" fill="${INK}" font-family="Gochi Hand">NO SURVIVORS</text>`
    );
    parts.push(
      `<text x="${boxX + 30}" y="${boxY + 88}" font-size="21" fill="${FADED}" font-family="Patrick Hand">total wipeout — the wall of stones is the only winner</text>`
    );
  }

  parts.push(
    `<text x="${LEFT}" y="${H - 26}" font-size="17" fill="${FADED}" font-family="Caveat">round roots + the survivor cert live in the Memo trail on Solana devnet · verify with no wallet</text>`
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join(
    ""
  )}</svg>`;
}

export function renderGraveyardReel(data: ReelCardData): Buffer {
  return toPng(graveyardReelSvg(data), 1080);
}
