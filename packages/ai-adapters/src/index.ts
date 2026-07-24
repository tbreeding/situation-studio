import { sha256 } from "@situation-studio/domain";
import { z } from "zod";

export const findingSchema = z.object({
  id: z.string().min(1).max(120),
  severity: z.enum(["note", "consider", "important", "blocking"]),
  targetKind: z.enum(["SECTION", "METADATA", "SCOPED_VARIANT", "RELATIONSHIP"]),
  targetKey: z.string().min(1).max(240),
  summary: z.string().min(1).max(4_000),
  rationale: z.string().min(1).max(12_000),
});

export const candidateEditSchema = z.object({
  id: z.uuid(),
  targetKind: z.enum(["SECTION", "METADATA", "SCOPED_VARIANT", "RELATIONSHIP"]),
  targetKey: z.string().min(1).max(240),
  beforeHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  afterBody: z.string().max(512_000),
  rationale: z.string().min(1).max(12_000),
});

export const normalizedOutputSchema = z.object({
  role: z.string().min(1).max(100),
  summary: z.string().min(1).max(12_000),
  findings: z.array(findingSchema).max(200),
  provenance: z.string().min(1).max(2_000),
});

export const bundleWriterOutputSchema = normalizedOutputSchema.extend({
  candidateEdits: z.array(candidateEditSchema).max(200),
});

export type AdapterOutput =
  | z.infer<typeof normalizedOutputSchema>
  | z.infer<typeof bundleWriterOutputSchema>;

export type AdapterRequest = {
  provider: "openai" | "anthropic" | "deterministic";
  model: string;
  role: string;
  effort: "low" | "medium" | "high" | "xhigh";
  system: string;
  evidence: string;
  outputKind: "review" | "bundle-writer";
  signal?: AbortSignal;
};

export type AdapterResult = {
  requestedProvider: AdapterRequest["provider"];
  resolvedProvider: AdapterRequest["provider"];
  requestedModel: string;
  resolvedModel: string;
  output: AdapterOutput;
  outputHash: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimated: boolean;
  };
};

export type AdapterFailureClass =
  | "CAPACITY"
  | "TRANSIENT"
  | "AUTHENTICATION"
  | "INVALID_OUTPUT"
  | "APPLICATION"
  | "CANCELLED";

export class AdapterFailure extends Error {
  constructor(
    readonly failureClass: AdapterFailureClass,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

function outputSchemaFor(request: AdapterRequest) {
  return request.outputKind === "bundle-writer"
    ? bundleWriterOutputSchema
    : normalizedOutputSchema;
}

function assertAllowedRequest(request: AdapterRequest) {
  if (request.evidence.length > 2 * 1024 * 1024)
    throw new AdapterFailure(
      "APPLICATION",
      "Review evidence exceeds the worker limit.",
      false,
    );
  if (
    /(?:DATABASE_URL|API_KEY|PASSWORD|SESSION_SECRET)\s*=/u.test(
      request.evidence,
    )
  )
    throw new AdapterFailure(
      "APPLICATION",
      "Review evidence resembles secret material.",
      false,
    );
}

function extractJson(text: string, request: AdapterRequest): AdapterOutput {
  try {
    return outputSchemaFor(request).parse(JSON.parse(text));
  } catch {
    throw new AdapterFailure(
      "INVALID_OUTPUT",
      "Provider output did not satisfy the normalized schema.",
      true,
    );
  }
}

function classifyHttpFailure(status: number) {
  if (status === 401 || status === 403)
    return { failureClass: "AUTHENTICATION" as const, retryable: false };
  if (status === 408 || status === 409 || status === 429 || status >= 500)
    return {
      failureClass:
        status === 429 ? ("CAPACITY" as const) : ("TRANSIENT" as const),
      retryable: true,
    };
  return { failureClass: "APPLICATION" as const, retryable: false };
}

async function checkedFetch(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
) {
  try {
    const response = await fetch(url, {
      ...init,
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const failure = classifyHttpFailure(response.status);
      throw new AdapterFailure(
        failure.failureClass,
        `Provider request failed with HTTP ${response.status}.`,
        failure.retryable,
      );
    }
    return response;
  } catch (error) {
    if (error instanceof AdapterFailure) throw error;
    if (signal?.aborted)
      throw new AdapterFailure(
        "CANCELLED",
        "Provider request cancelled.",
        false,
      );
    throw new AdapterFailure("TRANSIENT", "Provider transport failed.", true);
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 2 * 1024 * 1024)
    throw new AdapterFailure(
      "INVALID_OUTPUT",
      "Provider output exceeded the response limit.",
      false,
    );
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
    throw new AdapterFailure(
      "INVALID_OUTPUT",
      "Provider output exceeded the response limit.",
      false,
    );
  try {
    return JSON.parse(text);
  } catch {
    throw new AdapterFailure(
      "INVALID_OUTPUT",
      "Provider response was not JSON.",
      true,
    );
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
        store: false,
        reasoning: { effort: request.effort },
        instructions: request.system,
        input: request.evidence,
        text: {
          format: {
            type: "json_schema",
            name: "studio_review_output",
            strict: true,
            schema: z.toJSONSchema(outputSchemaFor(request)),
          },
        },
      }),
    },
    request.signal,
  );
  const payload = (await boundedJson(response)) as {
    model?: string;
    output_text?: string;
    output?: Array<{
      content?: Array<{ type?: string; text?: string }>;
    }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const outputText =
    payload.output_text ??
    payload.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text ??
    "";
  const output = extractJson(outputText, request);
  return {
    requestedProvider: "openai",
    resolvedProvider: "openai",
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
        system: `${request.system}\nReturn only JSON matching the supplied output contract.`,
        messages: [{ role: "user", content: request.evidence }],
      }),
    },
    request.signal,
  );
  const payload = (await boundedJson(response)) as {
    model?: string;
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const output = extractJson(
    payload.content?.find((item) => item.type === "text")?.text ?? "",
    request,
  );
  return {
    requestedProvider: "anthropic",
    resolvedProvider: "anthropic",
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
  const output = outputSchemaFor(request).parse({
    role: request.role,
    summary: "Deterministic fixture completed.",
    findings: [],
    provenance: "deterministic-provider-v1",
    ...(request.outputKind === "bundle-writer" ? { candidateEdits: [] } : {}),
  });
  return {
    requestedProvider: "deterministic",
    resolvedProvider: "deterministic",
    requestedModel: request.model,
    resolvedModel: "deterministic-provider-v1",
    output,
    outputHash: sha256(JSON.stringify(output)),
    usage: { inputTokens: 0, outputTokens: 0, estimated: false },
  };
}

export async function runWithFallback(
  request: Omit<AdapterRequest, "provider" | "model">,
  configuration: {
    mode: "deterministic" | "service";
    openai?: { apiKey: string; model: string };
    anthropic?: { apiKey: string; model: string };
  },
) {
  if (configuration.mode === "deterministic")
    return runDeterministic({
      ...request,
      provider: "deterministic",
      model: "deterministic-provider-v1",
    });
  if (configuration.openai) {
    try {
      return await runOpenAI(
        {
          ...request,
          provider: "openai",
          model: configuration.openai.model,
        },
        configuration.openai.apiKey,
      );
    } catch (error) {
      if (!(error instanceof AdapterFailure) || !error.retryable) throw error;
    }
  }
  if (configuration.anthropic)
    return runAnthropic(
      {
        ...request,
        provider: "anthropic",
        model: configuration.anthropic.model,
      },
      configuration.anthropic.apiKey,
    );
  throw new AdapterFailure(
    "AUTHENTICATION",
    "No service provider route is configured.",
    false,
  );
}
