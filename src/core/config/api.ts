import type { ConfigWingName, ConfigWingValueMap } from "./configWings.ts"
import { readConfigWing, writeConfigWing } from "../session/store.ts"

export function ConfigRead<T extends ConfigWingName>(rootDir: string, wing: T): ConfigWingValueMap[T] {
  return readConfigWing(rootDir, wing)
}

export function ConfigWrite<T extends ConfigWingName>(rootDir: string, wing: T, value: ConfigWingValueMap[T]) {
  return writeConfigWing(rootDir, wing, value)
}
