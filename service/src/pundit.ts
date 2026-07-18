import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

/**
 * The graveside announcer. Deterministic template voice by default — the
 * product never depends on an external API — with an optional Anthropic
 * polish pass when ANTHROPIC_API_KEY is present. Lines are seeded by
 * (lobby, round, name) so replays are stable and testable.
 *
 * House rules: mock the pick, never the person. One emoji ceiling. Family
 * mode always.
 */

function seedPick<T>(seedParts: string[], arr: T[]): T {
  const h = createHash("sha256").update(seedParts.join("|")).digest();
  return arr[h.readUInt32BE(0) % arr.length];
}

const FUNERALS = [
  (name: string, pick: string, minute: number) =>
    `${name} backed "${pick}" and the ${minute}' said no. Carried out of the pool by their own confidence.`,
  (name: string, pick: string, minute: number) =>
    `Here lies ${name}'s run — cause of death: "${pick}", minute ${minute}. The group will not observe a silence.`,
  (name: string, pick: string, minute: number) =>
    `${name} looked at the match, looked at the options, and chose "${pick}". The ${minute}' minute has filed its report.`,
  (name: string, pick: string, minute: number) =>
    `"${pick}" — ${name}'s final words, minute ${minute}. Etched on the chart forever, which is the point.`,
];

const SILENT_FUNERALS = [
  (name: string, minute: number) =>
    `${name} said nothing, and in a sudden-death pool silence is also an answer. Gone at ${minute}'.`,
  (name: string, minute: number) =>
    `${name} froze. The window closed at ${minute}' and the pool closed over them.`,
  (name: string, minute: number) =>
    `No pick from ${name}. The chart doesn't record excuses, only tombstones. ${minute}'.`,
];

export function funeralLine(opts: {
  lobbyId: string;
  roundN: number;
  name: string;
  reason: "wrong" | "silent";
  pickLabel?: string;
  minute: number;
}): string {
  if (opts.reason === "silent" || !opts.pickLabel) {
    const f = seedPick([opts.lobbyId, String(opts.roundN), opts.name, "s"], SILENT_FUNERALS);
    return f(opts.name, opts.minute);
  }
  const f = seedPick([opts.lobbyId, String(opts.roundN), opts.name], FUNERALS);
  return f(opts.name, opts.pickLabel, opts.minute);
}

const JINX_LINES = [
  (jinxer: string, target: string) =>
    `KIRICOCHO. ${jinxer} put the curse on ${target} and the football obliged. Credited on the chart.`,
  (jinxer: string, target: string) =>
    `${target} was fine until ${jinxer} whispered kiricocho. Superstition: 1, ${target}: 0.`,
];

export function jinxCreditLine(lobbyId: string, jinxer: string, target: string): string {
  return seedPick([lobbyId, jinxer, target], JINX_LINES)(jinxer, target);
}

export function jinxCastLine(jinxer: string, target: string): string {
  return `\u{1F9FF} ${jinxer} has cast KIRICOCHO on ${target}. If ${target} falls this round, the chart remembers who did it.`;
}

const HAUNTS = [
  (ghost: string) => `${ghost} rattles the group chat from beyond. The living pretend not to hear.`,
  (ghost: string) => `A cold draft. It's ${ghost}, haunting the pool they used to be alive in.`,
  (ghost: string) => `${ghost} knocks once from under the wall chart. Spooky. Still eliminated though.`,
];

export function hauntLine(lobbyId: string, ghost: string): string {
  return seedPick([lobbyId, ghost, "haunt"], HAUNTS)(ghost);
}

export function coronationLine(name: string, roundsSurvived: number, sole: boolean): string {
  return sole
    ? `\u{1F3C6} LAST FAN STANDING: ${name}. ${roundsSurvived} sudden-death calls, zero mistakes, and a certificate to prove every one of them. Nobody argues with the chart.`
    : `\u{1F3C6} The final whistle finds ${name} still standing. Co-survivor — the chart splits the crown, the certificates don't lie.`;
}

/**
 * Optional polish pass: rewrites a template line in a sharper voice when an
 * API key is present. Failures fall back to the template — the funeral is
 * never silent.
 */
export class Pundit {
  private client?: Anthropic;

  constructor(apiKey = process.env.ANTHROPIC_API_KEY) {
    if (apiKey) this.client = new Anthropic({ apiKey });
  }

  get mode(): "llm" | "template" {
    return this.client ? "llm" : "template";
  }

  async polish(line: string, context: string): Promise<string> {
    if (!this.client) return line;
    try {
      const res = await this.client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 100,
        system: [
          {
            type: "text",
            text:
              "You punch up one-line football group-chat eulogies for a survivor-pool bot. " +
              "Keep the same facts (names, picks, minutes) exactly. Mock the pick, never the person. " +
              "One sentence or two, max one emoji, family-friendly. Return only the line.",
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: `Context: ${context}\nLine: ${line}` }],
      });
      const text = res.content.find((c) => c.type === "text");
      return text && "text" in text ? text.text.trim() : line;
    } catch (e) {
      console.error("[pundit] polish failed, using template:", (e as Error).message?.slice(0, 120));
      return line;
    }
  }
}
