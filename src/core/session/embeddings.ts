import { pipeline, env } from '@xenova/transformers';
import { join } from 'node:path';
import { getPaths } from '../ipc/protocol.ts';

class EmbeddingsPipeline {
  static task = 'feature-extraction' as const;
  static model = 'Xenova/all-MiniLM-L6-v2';
  static instance: any = null;

  static async getInstance(rootDir: string) {
    if (this.instance === null) {
      // Configuramos para que el modelo IA de 22MB se guarde limpio junto al resto del proyecto
      env.cacheDir = join(getPaths(rootDir).baseDir, "models_cache");
      
      this.instance = await pipeline(this.task, this.model);
    }
    return this.instance;
  }
}

/**
 * Convierte un bloque de texto en un vector RAG estandarizado de 384 dimensiones.
 * Si es la primera vez que se ejecuta, descargará el modelo optimizado (~22MB) a la caché local.
 */
export async function generateEmbedding(rootDir: string, text: string): Promise<Float32Array> {
  const embedder = await EmbeddingsPipeline.getInstance(rootDir);
  // Al usar pooling: "mean" y normalize: true, obtenemos el estándar L2-normalized de 384 floats.
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return result.data as Float32Array;
}
