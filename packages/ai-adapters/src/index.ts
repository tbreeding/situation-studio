import {
  detectSensitiveText,
  MODEL_POLICY,
  sha256,
} from "@situation-studio/domain";
import { z } from "zod";

export type ProviderName = "anthropic" | "openai" | "deterministic";
export type AllowedModel = "opus" | "gpt-5.6-sol" | "deterministic-fixture-v1";
export type AllowedEffort = (typeof MODEL_POLICY.efforts)[number];
export type FailureClass =
  | "CAPACITY"
  | "TRANSIENT"
  | "AUTHENTICATION"
  | "INVALID_OUTPUT"
  | "APPLICATION"
  | "CANCELLED"
  | "SENSITIVE_INPUT";

export const normalizedOutputSchema = z.object({
  role: z.string().min(1),
  summary: z.string(),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(["info", "warning", "blocking"]),
      message: z.string(),
    }),
  ),
  provenance: z.string().min(1),
});

export type NormalizedOutput = z.infer<typeof normalizedOutputSchema>;
export type AdapterRequest = {
  provider: ProviderName;
  model: AllowedModel;
  effort: AllowedEffort;
  role: string;
  system: string;
  evidence: string;
  signal?: AbortSignal;
};
export type AdapterResult = {
  requestedModel: AllowedModel;
  resolvedModel: string;
  output: NormalizedOutput;
  outputHash: string;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
};

export class AdapterFailure extends Error {
  constructor(
    public readonly failureClass: FailureClass,
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function assertAllowedRequest(request: AdapterRequest) {
  if (!MODEL_POLICY.efforts.includes(request.effort))
    throw new AdapterFailure(
      "APPLICATION",
      "Effort is not allowlisted.",
      false,
    );
  if (request.provider === "anthropic" && request.model !== "opus")
    throw new AdapterFailure(
      "APPLICATION",
      "Anthropic model is not allowlisted.",
      false,
    );
  if (request.provider === "openai" && request.model !== "gpt-5.6-sol")
    throw new AdapterFailure(
      "APPLICATION",
      "OpenAI model is not allowlisted.",
      false,
    );
  if (
    request.provider === "deterministic" &&
    request.model !== "deterministic-fixture-v1"
  )
    throw new AdapterFailure(
      "APPLICATION",
      "Fixture model is not allowlisted.",
      false,
    );
  const sensitive = detectSensitiveText(
    `${request.system}\n${request.evidence}`,
  );
  if (sensitive.blocked)
    throw new AdapterFailure(
      "SENSITIVE_INPUT",
      "Sensitive input was blocked before provider transmission.",
      false,
    );
}

export function classifyHttpFailure(
  status: number,
): Pick<AdapterFailure, "failureClass" | "retryable"> {
  if (status === 401 || status === 403)
    return { failureClass: "AUTHENTICATION", retryable: false };
  if (status === 408 || status === 409 || status === 429)
    return { failureClass: "CAPACITY", retryable: true };
  if (status >= 500) return { failureClass: "TRANSIENT", retryable: true };
  return { failureClass: "APPLICATION", retryable: false };
}

function extractJson(text: string): NormalizedOutput {
  try {
    return normalizedOutputSchema.parse(JSON.parse(text));
  } catch {
    throw new AdapterFailure(
      "INVALID_OUTPUT",
      "Provider output did not satisfy the normalized schema.",
      true,
    );
  }
}

async function checkedFetch(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    const response = await fetch(url, {
      ...init,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      throw new AdapterFailure(
        classified.failureClass,
        `Provider request failed with HTTP ${response.status}.`,
        classified.retryable,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AdapterFailure) throw error;
    if (signal?.aborted)
      throw new AdapterFailure(
        "CANCELLED",
        "Provider request was cancelled.",
        false,
      );
    throw new AdapterFailure("TRANSIENT", "Provider transport failed.", true);
  }
}

export async function runOpenAI(
  request: AdapterRequest,
  apiKey: string,
): Promise<AdapterResult> {
  assertAllowedRequest(request);
  if (request.provider !== "openai" || !apiKey)
    throw new AdapterFailure(
      "AUTHENTICATION",
      "OpenAI service credential is unavailable.",
      false,
    );
  const response = await checkedFetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        reasoning: { effort: request.effort },
        input: [
          { role: "system", content: request.system },
          { role: "user", content: request.evidence },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "studio_role_output",
            strict: true,
            schema: z.toJSONSchema(normalizedOutputSchema),
          },
        },
      }),
    },
    request.signal,
  );
  const payload = (await response.json()) as {
    model?: string;
    output_text?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const output = extractJson(payload.output_text ?? "");
  return {
    requestedModel: request.model,
    resolvedModel: payload.model ?? request.model,
    output,
    outputHash: sha256(JSON.stringify(output)),
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      estimated: !payload.usage,
    },
  };
}

export async function runAnthropic(
  request: AdapterRequest,
  apiKey: string,
): Promise<AdapterResult> {
  assertAllowedRequest(request);
  if (request.provider !== "anthropic" || !apiKey)
    throw new AdapterFailure(
      "AUTHENTICATION",
      "Anthropic service credential is unavailable.",
      false,
    );
  const response = await checkedFetch(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: 4096,
        system: request.system,
        messages: [{ role: "user", content: request.evidence }],
      }),
    },
    request.signal,
  );
  const payload = (await response.json()) as {
    model?: string;
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const output = extractJson(
    payload.content?.find((item) => item.type === "text")?.text ?? "",
  );
  return {
    requestedModel: request.model,
    resolvedModel: payload.model ?? request.model,
    output,
    outputHash: sha256(JSON.stringify(output)),
    usage: {
      inputTokens: payload.usage?.input_tokens ?? 0,
      outputTokens: payload.usage?.output_tokens ?? 0,
      estimated: !payload.usage,
    },
  };
}

export async function runDeterministic(
  request: AdapterRequest,
): Promise<AdapterResult> {
  assertAllowedRequest(request);
  const output = normalizedOutputSchema.parse({
    role: request.role,
    summary: "Deterministic fixture completed.",
    findings: [],
    provenance: "deterministic-fixture-v1",
  });
  return {
    requestedModel: request.model,
    resolvedModel: "deterministic-fixture-v1",
    output,
    outputHash: sha256(JSON.stringify(output)),
    usage: { inputTokens: 0, outputTokens: 0, estimated: false },
  };
}
