import { pipeline, env } from '@xenova/transformers';
import { join } from 'node:path';
import { getPaths } from '../ipc/protocol.ts';

type EmbeddingWarmupState = "idle" | "warming" | "ready" | "failed"

class EmbeddingsPipeline {
  static task = 'feature-extraction' as const;
  static model = 'Xenova/all-MiniLM-L6-v2';
  static instance: any = null;
  static state: EmbeddingWarmupState = "idle";
  static lastError: string | null = null;
  static pending: Promise<any> | null = null;

  static async getInstance(rootDir: string) {
    if (this.instance !== null) {
      this.state = "ready";
      return this.instance;
    }
    if (this.pending) return await this.pending;

    // Configuramos para que el modelo IA de 22MB se guarde limpio junto al resto del proyecto
    env.cacheDir = join(getPaths(rootDir).baseDir, "models_cache");
    this.state = "warming";
    this.lastError = null;

    this.pending = pipeline(this.task, this.model)
      .then(instance => {
        this.instance = instance
        this.state = "ready"
        this.pending = null
        return instance
      })
      .catch(error => {
        this.state = "failed"
        this.lastError = error instanceof Error ? error.message : String(error)
        this.pending = null
        throw error
      })

    return await this.pending;
  }
}

function toEmbeddingsError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`Embeddings unavailable: ${message}`)
}

export function isEmbeddingsUnavailableError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith("Embeddings unavailable:")
}

export function getEmbeddingsStatus() {
  return {
    state: EmbeddingsPipeline.state,
    model: EmbeddingsPipeline.model,
    cacheDir: env.cacheDir,
    lastError: EmbeddingsPipeline.lastError,
  }
}

export async function warmupEmbeddings(rootDir: string) {
  try {
    await EmbeddingsPipeline.getInstance(rootDir)
    return { ok: true as const, ...getEmbeddingsStatus() }
  } catch (error) {
    return {
      ok: false as const,
      ...getEmbeddingsStatus(),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Convierte un bloque de texto en un vector RAG estandarizado de 384 dimensiones.
 * Si es la primera vez que se ejecuta, descargará el modelo optimizado (~22MB) a la caché local.
 */
export async function generateEmbedding(rootDir: string, text: string): Promise<Float32Array> {
  try {
    const embedder = await EmbeddingsPipeline.getInstance(rootDir);
    // Al usar pooling: "mean" y normalize: true, obtenemos el estándar L2-normalized de 384 floats.
    const result = await embedder(text, { pooling: 'mean', normalize: true });
    return result.data as Float32Array;
  } catch (error) {
    throw toEmbeddingsError(error)
  }
}
