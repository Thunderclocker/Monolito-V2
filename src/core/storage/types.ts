/** File-backed memory store (boot/*.md + memory.md). */
export type MemoryStore = {
  readBootWing(wing: string): string | null
  writeBootWing(wing: string, content: string, append?: boolean): void
  bootWingExists(wing: string): boolean
  listBootWings(): string[]
  loadMemoryMd(): string
  writeMemoryMd(content: string): void
  upsertMemorySection(sectionTitle: string, content: string, tags?: string[]): { action: "inserted" | "updated" | "skipped" }
  buildCachedContextBlock(): string
  ensureSeeded(): void
}
