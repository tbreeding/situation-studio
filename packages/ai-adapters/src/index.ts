import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

export const bundleWriterOutputSchema = normalizedOutputSchema.extend({
  candidateEdits: z.array(
    z.object({
      path: z.string().min(1),
      find: z.string().min(1),
      replace: z.string(),
      rationale: z.string().min(1),
    }),
  ),
});

export type NormalizedOutput = z.infer<typeof normalizedOutputSchema>;
export type BundleWriterOutput = z.infer<typeof bundleWriterOutputSchema>;
export type AdapterOutput = NormalizedOutput | BundleWriterOutput;
export type AdapterRequest = {
  provider: ProviderName;
  model: AllowedModel;
  effort: AllowedEffort;
  role: string;
  system: string;
  evidence: string;
  outputKind?: "review" | "bundle-writer";
  signal?: AbortSignal;
};
export type AdapterResult = {
  requestedModel: AllowedModel;
  resolvedModel: string;
  output: AdapterOutput;
  outputHash: string;
  usage: { inputTokens: number; outputTokens: number; estimated: boolean };
};

type CliResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const CLI_TIMEOUT_MS = 5 * 60 * 1000;
const CLI_OUTPUT_LIMIT = 10 * 1024 * 1024;

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

function outputSchemaFor(request: AdapterRequest) {
  return request.outputKind === "bundle-writer"
    ? bundleWriterOutputSchema
    : normalizedOutputSchema;
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

function cliFailure(result: CliResult): AdapterFailure {
  const evidence = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut)
    return new AdapterFailure("TRANSIENT", "Provider CLI timed out.", true);
  if (
    /usage limit|rate limit|limit reached|quota|out of (?:usage|credits)|too many requests|\b429\b|overloaded/iu.test(
      evidence,
    )
  )
    return new AdapterFailure(
      "CAPACITY",
      "Provider CLI capacity is unavailable.",
      true,
    );
  if (
    /OAuth token (?:revoked|has expired)|please run \/login|authentication_error|not logged in|unauthorized/iu.test(
      evidence,
    )
  )
    return new AdapterFailure(
      "AUTHENTICATION",
      "Provider CLI authentication is unavailable.",
      false,
    );
  return new AdapterFailure(
    "APPLICATION",
    `Provider CLI exited unsuccessfully (${result.code ?? "signal"}).`,
    false,
  );
}

async function spawnCli(
  binary: string,
  args: string[],
  input: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const stop = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, CLI_TIMEOUT_MS);
    timeout.unref();
    const onAbort = () => stop();
    signal?.addEventListener("abort", onAbort, { once: true });
    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      if (stdout.length + stderr.length > CLI_OUTPUT_LIMIT) stop();
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(
        new AdapterFailure(
          "APPLICATION",
          `Provider CLI could not start: ${error.message}`,
          false,
        ),
      );
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

function restrictedCliEnvironment(
  additions: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    LANG: process.env.LANG ?? "C.UTF-8",
    ...Object.fromEntries(
      Object.entries(additions).filter((entry): entry is [string, string] =>
        Boolean(entry[1]),
      ),
    ),
  };
}

export async function runCodexCli(
  request: AdapterRequest,
  options: { binary?: string; codexHome?: string } = {},
): Promise<AdapterResult> {
  assertAllowedRequest(request);
  if (request.provider !== "openai" || request.model !== "gpt-5.6-sol")
    throw new AdapterFailure(
      "APPLICATION",
      "Codex CLI requires the OpenAI policy route.",
      false,
    );
  const directory = await mkdtemp(path.join(tmpdir(), "studio-codex-"));
  try {
    const schemaPath = path.join(directory, "output.schema.json");
    const outputPath = path.join(directory, "output.json");
    await writeFile(
      schemaPath,
      JSON.stringify(z.toJSONSchema(outputSchemaFor(request))),
      { mode: 0o600 },
    );
    const result = await spawnCli(
      options.binary ?? process.env.CODEX_BIN ?? "codex",
      [
        "exec",
        "-",
        "--model",
        request.model,
        "--sandbox",
        "read-only",
        "--cd",
        directory,
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--color",
        "never",
        "--config",
        `model_reasoning_effort=\"${request.effort}\"`,
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
      ],
      `${request.system}\n\n${request.evidence}`,
      directory,
      restrictedCliEnvironment({
        CODEX_HOME: options.codexHome ?? process.env.CODEX_HOME,
      }),
      request.signal,
    );
    if (request.signal?.aborted)
      throw new AdapterFailure(
        "CANCELLED",
        "Provider request was cancelled.",
        false,
      );
    if (result.code !== 0) throw cliFailure(result);
    const output = extractJson(await readFile(outputPath, "utf8"), request);
    return {
      requestedModel: request.model,
      resolvedModel: request.model,
      output,
      outputHash: sha256(JSON.stringify(output)),
      usage: { inputTokens: 0, outputTokens: 0, estimated: true },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runClaudeCli(
  request: AdapterRequest,
  options: { binary?: string; oauthToken?: string } = {},
): Promise<AdapterResult> {
  assertAllowedRequest(request);
  if (request.provider !== "anthropic" || request.model !== "opus")
    throw new AdapterFailure(
      "APPLICATION",
      "Claude CLI requires the Anthropic policy route.",
      false,
    );
  const oauthToken = options.oauthToken ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken)
    throw new AdapterFailure(
      "AUTHENTICATION",
      "Claude CLI validation credential is unavailable.",
      false,
    );
  const directory = await mkdtemp(path.join(tmpdir(), "studio-claude-"));
  try {
    const result = await spawnCli(
      options.binary ?? process.env.CLAUDE_BIN ?? "claude",
      [
        "-p",
        "--model",
        request.model,
        "--effort",
        request.effort,
        "--safe-mode",
        "--disable-slash-commands",
        "--allowedTools",
        "",
        "--no-session-persistence",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(z.toJSONSchema(outputSchemaFor(request))),
      ],
      `${request.system}\n\n${request.evidence}`,
      directory,
      restrictedCliEnvironment({
        CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        CLAUDE_CODE_NONINTERACTIVE: "1",
      }),
      request.signal,
    );
    if (request.signal?.aborted)
      throw new AdapterFailure(
        "CANCELLED",
        "Provider request was cancelled.",
        false,
      );
    if (result.code !== 0) throw cliFailure(result);
    const payload = JSON.parse(result.stdout) as {
      structured_output?: unknown;
      modelUsage?: Record<
        string,
        { inputTokens?: number; outputTokens?: number }
      >;
    };
    const output = outputSchemaFor(request).parse(payload.structured_output);
    const usage = Object.values(payload.modelUsage ?? {}).reduce<{
      inputTokens: number;
      outputTokens: number;
    }>(
      (total, item) => ({
        inputTokens: total.inputTokens + (item.inputTokens ?? 0),
        outputTokens: total.outputTokens + (item.outputTokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0 },
    );
    return {
      requestedModel: request.model,
      resolvedModel:
        Object.keys(payload.modelUsage ?? {}).find((model) =>
          model.toLowerCase().includes(request.model),
        ) ?? request.model,
      output,
      outputHash: sha256(JSON.stringify(output)),
      usage: { ...usage, estimated: false },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
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
        store: false,
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
            schema: z.toJSONSchema(outputSchemaFor(request)),
          },
        },
      }),
    },
    request.signal,
  );
  const payload = (await response.json()) as {
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
    request,
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
  const output = outputSchemaFor(request).parse({
    role: request.role,
    summary: "Deterministic fixture completed.",
    findings: [],
    provenance: "deterministic-fixture-v1",
    ...(request.outputKind === "bundle-writer" ? { candidateEdits: [] } : {}),
  });
  return {
    requestedModel: request.model,
    resolvedModel: "deterministic-fixture-v1",
    output,
    outputHash: sha256(JSON.stringify(output)),
    usage: { inputTokens: 0, outputTokens: 0, estimated: false },
  };
}
