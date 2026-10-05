// LLM-as-judge for generation quality. Two separate calls so the faithfulness judge never sees
// the reference answer: faithfulness asks "is every claim supported by the retrieved context?"
// (hallucination), correctness asks "does it match the reference?" (usefulness). They fail differently.
//
// Works with either engine. Claude (JUDGE_PROVIDER=anthropic) is the trustworthy grader; a small
// local model is a free but rough grader, so its results are labelled "indicative" in the dashboard.
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { sourceLabel } from "../answer.js";
import { JUDGE_MODEL, JUDGE_PROVIDER } from "../config.js";
import { anthropic, FALLBACK_PARAMS, type UsageMeter } from "../llm.js";
import { chatJSON } from "../ollama.js";
import type { RetrievedChunk } from "../types.js";

const FaithfulnessSchema = z.object({
  claims: z.array(
    z.object({
      claim: z.string().describe("One atomic factual claim made in the answer"),
      verdict: z.enum(["supported", "partially_supported", "unsupported"]),
      source_numbers: z.array(z.number()).describe("Context passage numbers that support the claim; empty if unsupported"),
    }),
  ),
});

const CorrectnessSchema = z.object({
  verdict: z.enum(["correct", "partially_correct", "incorrect"]),
  rationale: z.string().describe("One or two sentences"),
});

export type FaithfulnessResult = z.infer<typeof FaithfulnessSchema> & { score: number };
export type CorrectnessResult = z.infer<typeof CorrectnessSchema>;

const FAITHFULNESS_RUBRIC = `You are grading a RAG system's answer for faithfulness to its retrieved context.
1. Split the answer into atomic factual claims. Ignore citation markers like [1], hedges, and statements that the documents do not cover something.
2. For each claim, decide whether the numbered context passages support it:
   - supported: stated in or directly entailed by the passages.
   - partially_supported: the core is in the passages but the answer adds a detail, number, or generalization that is not.
   - unsupported: not in the passages (even if true in the real world).
Judge only against the passages, never your own knowledge. If the answer makes no factual claims, return an empty list.`;

const CORRECTNESS_RUBRIC = `You are grading a RAG system's answer against a reference answer written by a human.
- correct: conveys the key facts of the reference; extra accurate detail is fine; wording may differ.
- partially_correct: some key facts present but others missing or imprecise.
- incorrect: wrong, missing the key facts, or declines to answer when the reference has an answer.
If the reference says the question is not covered by the corpus, the answer is correct only if it declines to answer (and does not invent one).`;

/** Runs one structured judge call on the configured provider and validates it against the schema. */
async function judge<T extends z.ZodType>(schema: T, system: string, user: string, effort: "low" | "medium", meter?: UsageMeter): Promise<z.infer<T>> {
  if (JUDGE_PROVIDER === "anthropic") {
    const res = await anthropic().beta.messages.parse({
      ...FALLBACK_PARAMS,
      model: JUDGE_MODEL,
      max_tokens: 16000,
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: "user", content: user }],
    });
    meter?.add(res.model, res.usage);
    if (!res.parsed_output) throw new Error(`Judge returned no parseable output (stop_reason=${res.stop_reason})`);
    return res.parsed_output as z.infer<T>;
  }
  const res = await chatJSON(
    JUDGE_MODEL,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    z.toJSONSchema(schema),
  );
  meter?.add(res.model, { input_tokens: res.promptTokens, output_tokens: res.outputTokens });
  const parsed = schema.safeParse(res.json);
  if (!parsed.success) throw new Error(`Judge output failed schema validation: ${parsed.error.message}`);
  return parsed.data;
}

export async function judgeFaithfulness(answer: string, context: RetrievedChunk[], meter?: UsageMeter): Promise<FaithfulnessResult> {
  const passages = context.map((rc, i) => `<passage n="${i + 1}" source="${sourceLabel(rc)}">\n${rc.chunk.text}\n</passage>`).join("\n");
  const out = await judge(
    FaithfulnessSchema,
    FAITHFULNESS_RUBRIC,
    `<context>\n${passages}\n</context>\n\n<answer>\n${answer}\n</answer>`,
    "medium",
    meter,
  );
  const weights = { supported: 1, partially_supported: 0.5, unsupported: 0 } as const;
  const score = out.claims.length ? out.claims.reduce((s, c) => s + weights[c.verdict], 0) / out.claims.length : NaN;
  return { ...out, score };
}

export async function judgeCorrectness(question: string, reference: string, answer: string, meter?: UsageMeter): Promise<CorrectnessResult> {
  return judge(
    CorrectnessSchema,
    CORRECTNESS_RUBRIC,
    `<question>${question}</question>\n<reference>${reference}</reference>\n<answer>\n${answer}\n</answer>`,
    "low",
    meter,
  );
}
