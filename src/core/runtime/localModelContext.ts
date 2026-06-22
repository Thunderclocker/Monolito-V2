/**
 * Dynamic num_ctx for local Ollama models: Ollama metadata + GPU VRAM estimate.
 */

export type OllamaModelContextInfo = {
  model: string
  parameterCount: number
  quantizationLevel: string
  nativeContext: number
  capabilities: string[]
  modelInfo: Record<string, unknown>
  computedNumCtx: number
  fetchedAt: number
}

const contextCache = new Map<string, OllamaModelContextInfo>()

const GPU_OVERHEAD_MB = 1500
const GENERATION_RESERVE_MB = 768
const VISION_ENCODER_RESERVE_MB = 1024

const TIER_ABSOLUTE_MAX: Record<"12gb" | "8gb" | "default", number> = {
  "12gb": 32_768,
  "8gb": 16_384,
  default: 8_192,
}

function getVramTierFromEnv(): keyof typeof TIER_ABSOLUTE_MAX {
  const mb = Number.parseInt(process.env.MONOLITO_GPU_VRAM_MB ?? "", 10)
  if (Number.isFinite(mb) && mb >= 11_000) return "12gb"
  if (Number.isFinite(mb) && mb >= 7_000) return "8gb"
  return "default"
}

function getGpuVramMb(): number {
  const mb = Number.parseInt(process.env.MONOLITO_GPU_VRAM_MB ?? "", 10)
  if (Number.isFinite(mb) && mb > 0) return mb
  return 12_288
}

function quantBytesPerParam(quantLevel: string): number {
  const q = quantLevel.toUpperCase()
  if (q.includes("Q2")) return 0.35
  if (q.includes("Q3")) return 0.45
  if (q.includes("Q4")) return 0.55
  if (q.includes("Q5")) return 0.65
  if (q.includes("Q6")) return 0.75
  if (q.includes("Q8")) return 1.0
  if (q.includes("F16") || q.includes("FP16")) return 2.0
  return 0.6
}

export function estimateModelVramMb(parameterCount: number, quantizationLevel: string): number {
  if (!Number.isFinite(parameterCount) || parameterCount <= 0) return 4096
  return Math.ceil((parameterCount * quantBytesPerParam(quantizationLevel)) / (1024 * 1024))
}

export function estimateKvBytesPerToken(modelInfo: Record<string, unknown>): number {
  const arch = typeof modelInfo["general.architecture"] === "string"
    ? modelInfo["general.architecture"]
    : ""
  const prefix = arch ? `${arch}.` : ""
  const layers = Number(modelInfo[`${prefix}block_count`] ?? modelInfo["llama.block_count"] ?? 32)
  const embed = Number(modelInfo[`${prefix}embedding_length`] ?? 4096)
  const heads = Number(modelInfo[`${prefix}attention.head_count`] ?? 32)
  let kvHeads = Number(modelInfo[`${prefix}attention.head_count_kv`])
  if (!Number.isFinite(kvHeads) || kvHeads <= 0) {
    kvHeads = Math.max(1, Math.floor(heads / 4))
  }
  const headDim = embed / Math.max(1, heads)
  return Math.max(32, Math.ceil(layers * kvHeads * headDim * 4))
}

export function roundNumCtx(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 2048
  const rounded = Math.floor(value / 1024) * 1024
  return Math.max(2048, rounded)
}

export function parseOllamaShowPayload(model: string, payload: Record<string, unknown>): Omit<OllamaModelContextInfo, "fetchedAt"> {
  const modelInfo = (payload.model_info && typeof payload.model_info === "object")
    ? payload.model_info as Record<string, unknown>
    : {}
  const details = (payload.details && typeof payload.details === "object")
    ? payload.details as Record<string, unknown>
    : {}
  const arch = typeof modelInfo["general.architecture"] === "string" ? modelInfo["general.architecture"] : ""
  const nativeContext = Number(modelInfo[`${arch}.context_length`] ?? TIER_ABSOLUTE_MAX["12gb"])
  const parameterCount = Number(modelInfo["general.parameter_count"] ?? 0)
  const quantizationLevel = typeof details.quantization_level === "string" ? details.quantization_level : "Q4_K_M"
  const capabilities = Array.isArray(payload.capabilities)
    ? payload.capabilities.filter((c): c is string => typeof c === "string")
    : []

  return {
    model,
    parameterCount,
    quantizationLevel,
    nativeContext: Number.isFinite(nativeContext) && nativeContext > 0 ? nativeContext : 8192,
    capabilities,
    modelInfo,
    computedNumCtx: computeDynamicNumCtx({
      parameterCount,
      quantizationLevel,
      nativeContext,
      capabilities,
      modelInfo,
      familyCeiling: undefined,
    }),
  }
}

export function computeDynamicNumCtx(input: {
  parameterCount: number
  quantizationLevel: string
  nativeContext: number
  capabilities: string[]
  modelInfo: Record<string, unknown>
  /** Optional static family cap from localMode table. */
  familyCeiling?: number
  vramMb?: number
  tier?: keyof typeof TIER_ABSOLUTE_MAX
}): number {
  const vramMb = input.vramMb ?? getGpuVramMb()
  const tier = input.tier ?? getVramTierFromEnv()

  const modelMb = estimateModelVramMb(input.parameterCount, input.quantizationLevel)
  const visionReserve = input.capabilities.includes("vision") ? VISION_ENCODER_RESERVE_MB : 0
  const kvBudgetMb = vramMb - GPU_OVERHEAD_MB - GENERATION_RESERVE_MB - visionReserve - modelMb
  if (kvBudgetMb <= 0) return 2048

  const kvBytesPerToken = estimateKvBytesPerToken(input.modelInfo)
  const dynamicCtx = Math.floor((kvBudgetMb * 1024 * 1024) / kvBytesPerToken)
  const tierMax = TIER_ABSOLUTE_MAX[tier]
  const familyCap = input.familyCeiling ?? tierMax
  const ceiling = Math.min(input.nativeContext, tierMax, familyCap)
  return roundNumCtx(Math.min(dynamicCtx, ceiling))
}

export function getCachedOllamaModelContext(model: string): OllamaModelContextInfo | undefined {
  return contextCache.get(model.trim())
}

export function setCachedOllamaModelContext(info: OllamaModelContextInfo): void {
  contextCache.set(info.model.trim(), info)
}

export function invalidateOllamaModelContextCache(model?: string): void {
  if (model?.trim()) contextCache.delete(model.trim())
  else contextCache.clear()
}

export async function refreshOllamaModelContext(
  model: string,
  baseUrl = "http://127.0.0.1:11434",
  familyCeiling?: number,
): Promise<OllamaModelContextInfo | null> {
  const tag = model.trim()
  if (!tag) return null
  const root = baseUrl.trim().replace(/\/+$/, "") || "http://127.0.0.1:11434"
  try {
    const response = await fetch(`${root}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: tag }),
    })
    if (!response.ok) return null
    const payload = await response.json() as Record<string, unknown>
    const parsed = parseOllamaShowPayload(tag, payload)
    const computedNumCtx = computeDynamicNumCtx({
      ...parsed,
      familyCeiling,
    })
    const info: OllamaModelContextInfo = { ...parsed, computedNumCtx, fetchedAt: Date.now() }
    setCachedOllamaModelContext(info)
    return info
  } catch {
    return null
  }
}
