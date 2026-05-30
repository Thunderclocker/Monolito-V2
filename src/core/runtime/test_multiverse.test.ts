import test from "node:test"
import assert from "node:assert/strict"
import { rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { createCheckpointCommit, commitWorktreeChanges, mergeBranchIntoRoot } from "../context/gitContext.ts"
import { compileHandoffTranscript } from "./modelAdapter.ts"
import { type ConversationMessage } from "./providers/types.ts"

const TEST_ROOT = join(process.cwd(), "scratch", "test-multiverse-git")

test("Git context and multiverse workflow", async (t) => {
  // Clean & recreate
  rmSync(TEST_ROOT, { force: true, recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })

  try {
    // Inicializar un repositorio Git real en TEST_ROOT
    execSync("git init -b main", { cwd: TEST_ROOT })
    
    // Configurar usuario de Git para aislar tests
    execSync('git config user.name "Test User"', { cwd: TEST_ROOT })
    execSync('git config user.email "test@example.com"', { cwd: TEST_ROOT })

    // Crear commit inicial para habilitar worktrees
    writeFileSync(join(TEST_ROOT, "README.md"), "# Initial README")
    execSync("git add README.md", { cwd: TEST_ROOT })
    execSync('git commit -m "initial commit"', { cwd: TEST_ROOT })

    const initialHead = execSync("git rev-parse HEAD", { cwd: TEST_ROOT }).toString().trim()

    await t.test("createCheckpointCommit does nothing if clean", async () => {
      const head = await createCheckpointCommit(TEST_ROOT)
      assert.equal(head, initialHead)
    })

    await t.test("createCheckpointCommit creates a temp commit if dirty", async () => {
      // Modificar README.md y agregar un archivo sin seguimiento
      writeFileSync(join(TEST_ROOT, "README.md"), "# Updated README")
      writeFileSync(join(TEST_ROOT, "new_file.txt"), "hello")
      
      const head = await createCheckpointCommit(TEST_ROOT)
      assert.notEqual(head, initialHead)
      
      // El estado de Git debe estar limpio ahora
      const status = execSync("git status --porcelain", { cwd: TEST_ROOT }).toString().trim()
      assert.equal(status, "")
    })

    await t.test("commitWorktreeChanges and mergeBranchIntoRoot workflow", async () => {
      // 1. Crear un worktree en worktrees/worker-1
      const worktreePath = join(TEST_ROOT, "worktrees", "worker-1")
      mkdirSync(join(TEST_ROOT, "worktrees"), { recursive: true })
      
      const branchName = "monolito-worker-test"
      execSync(`git worktree add -b ${branchName} "${worktreePath}"`, { cwd: TEST_ROOT })
      
      assert.ok(existsSync(join(worktreePath, "README.md")))
      
      // 2. Modificar archivos en el worktree
      writeFileSync(join(worktreePath, "worker_result.txt"), "worker code works")
      
      // 3. Confirmar cambios usando nuestra utilidad defensiva
      await commitWorktreeChanges(worktreePath, "feat: worker finished")
      
      // 4. Fusionar la rama usando nuestra utilidad de merge
      await mergeBranchIntoRoot(TEST_ROOT, branchName)
      
      // Verificar que el archivo fusionado existe en la raíz
      assert.ok(existsSync(join(TEST_ROOT, "worker_result.txt")))
      assert.equal(execSync("git log -n 1 --oneline", { cwd: TEST_ROOT }).toString().trim().includes("feat: worker finished"), true)
      
      // 5. Remover el worktree
      execSync(`git worktree remove -f "${worktreePath}"`, { cwd: TEST_ROOT })
    })

  } finally {
    // Limpiar directorio de pruebas
    rmSync(TEST_ROOT, { force: true, recursive: true })
  }
})

test("compileHandoffTranscript serializes conversation messages efficiently", () => {
  const session = {
    id: "session-test",
    title: "Test Session",
    messages: [
      { id: "1", session_id: "session-test", role: "user", text: "Refactor auth.ts", created_at: "" }
    ],
    updated_at: ""
  } as any

  const conversationMessages: ConversationMessage[] = [
    { role: "user", content: "Refactor auth.ts" },
    { role: "assistant", content: "I will read the auth file.", toolCalls: [{ id: "call-1", name: "Read", input: { path: "src/auth.ts" } }] },
    { role: "tool", toolCallId: "call-1", toolName: "Read", content: '{"status":"success","content":"const auth = true;"}' },
    { role: "assistant", content: "Now I will compile.", toolCalls: [{ id: "call-2", name: "Bash", input: { command: "npm run build" } }] },
    { role: "tool", toolCallId: "call-2", toolName: "Bash", content: '{"exitCode":1,"stderr":"SyntaxError: Unexpected token in auth.ts"}' }
  ]

  const transcript = compileHandoffTranscript(session, conversationMessages, "Fix compilation errors")
  
  assert.ok(transcript.includes("TRASPASO DETALLADO"))
  assert.ok(transcript.includes("Fix compilation errors"))
  assert.ok(transcript.includes("Refactor auth.ts"))
  assert.ok(transcript.includes("LLAMADA HERRAMIENTA: Read"))
  assert.ok(transcript.includes("LLAMADA HERRAMIENTA: Bash"))
  assert.ok(transcript.includes("FALLO"))
  assert.ok(transcript.includes("SyntaxError: Unexpected token in auth.ts"))
})
