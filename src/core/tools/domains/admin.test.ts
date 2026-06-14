import test from "node:test"
import assert from "node:assert/strict"
import {
  adminTools,
  _setTestExecFile,
  _setTestExistsSync,
  _setTestUserInfo,
} from "./admin.ts"

// Find our tool
const tool = adminTools.find(t => t.name === "manage_sudo_mode")!

test("manage_sudo_mode validate input", () => {
  // Missing action
  let err = tool.validate!({} as any)
  assert.match(err || "", /invalid or missing/i)

  // Invalid action
  err = tool.validate!({ action: "invalid" })
  assert.match(err || "", /invalid or missing/i)

  // Valid status/deactivate actions without commands
  assert.equal(tool.validate!({ action: "status" }), null)
  assert.equal(tool.validate!({ action: "deactivate" }), null)

  // Valid activate without commands
  assert.equal(tool.validate!({ action: "activate" }), null)

  // Activate with invalid commands type
  assert.equal(tool.validate!({ action: "activate", commands: "not-an-array" as any }), "commands must be an array of strings")

  // Activate with empty command string
  assert.equal(tool.validate!({ action: "activate", commands: ["/bin/ls", ""] }), "each command must be a non-empty string")

  // Activate with valid command array
  assert.equal(tool.validate!({ action: "activate", commands: ["/usr/bin/systemctl"] }), null)
})

test("manage_sudo_mode run status: inactive", async () => {
  _setTestExistsSync(() => false)
  
  const result = await tool.run({ action: "status" }, {} as any) as string
  const parsed = JSON.parse(result)
  assert.equal(parsed.active, false)
  assert.match(parsed.message, /desactivado/i)
})

test("manage_sudo_mode run status: active and readable (ALL)", async () => {
  _setTestExistsSync(() => true)
  _setTestExecFile((async (cmd: any, args: any) => {
    assert.equal(cmd, "sudo")
    assert.deepEqual(args, ["-n", "cat", "/etc/sudoers.d/monolito-temp"])
    return { stdout: "cristian ALL=(ALL) NOPASSWD: ALL", stderr: "" }
  }) as any)

  const result = await tool.run({ action: "status" }, {} as any) as string
  const parsed = JSON.parse(result)
  assert.equal(parsed.active, true)
  assert.deepEqual(parsed.commands, ["ALL"])
  assert.match(parsed.message, /permitidos: ALL/i)
})

test("manage_sudo_mode run status: active and readable (specific commands)", async () => {
  _setTestExistsSync(() => true)
  _setTestExecFile((async () => {
    return { stdout: "cristian ALL=(ALL) NOPASSWD: /usr/bin/systemctl, /usr/bin/apt-get", stderr: "" }
  }) as any)

  const result = await tool.run({ action: "status" }, {} as any) as string
  const parsed = JSON.parse(result)
  assert.equal(parsed.active, true)
  assert.deepEqual(parsed.commands, ["/usr/bin/systemctl", "/usr/bin/apt-get"])
  assert.match(parsed.message, /systemctl/i)
})

test("manage_sudo_mode run status: active but unreadable", async () => {
  _setTestExistsSync(() => true)
  _setTestExecFile((async () => {
    throw new Error("Password required")
  }) as any)

  const result = await tool.run({ action: "status" }, {} as any) as string
  const parsed = JSON.parse(result)
  assert.equal(parsed.active, true)
  assert.equal(parsed.unreadable, true)
  assert.match(parsed.message, /no se puede leer/i)
})

test("manage_sudo_mode run deactivate: already inactive", async () => {
  _setTestExistsSync(() => false)

  const result = await tool.run({ action: "deactivate" }, {} as any)
  assert.match(result as string, /ya estaba desactivado/i)
})

test("manage_sudo_mode run deactivate: successful via sudo -n", async () => {
  _setTestExistsSync(() => true)
  let ranSudo = false
  _setTestExecFile((async (cmd: any, args: any) => {
    if (cmd === "sudo") {
      assert.deepEqual(args, ["-n", "rm", "-f", "/etc/sudoers.d/monolito-temp"])
      ranSudo = true
      return { stdout: "", stderr: "" }
    }
    throw new Error(`Unexpected command: ${cmd}`)
  }) as any)

  const result = await tool.run({ action: "deactivate" }, {} as any)
  assert.ok(ranSudo)
  assert.match(result as string, /desactivado con éxito/i)
})

test("manage_sudo_mode run deactivate: falls back to pkexec if sudo -n fails", async () => {
  _setTestExistsSync(() => true)
  let ranPkexec = false
  _setTestExecFile((async (cmd: any, args: any) => {
    if (cmd === "sudo") {
      throw new Error("Sudo failed")
    }
    if (cmd === "pkexec") {
      assert.deepEqual(args, ["rm", "-f", "/etc/sudoers.d/monolito-temp"])
      ranPkexec = true
      return { stdout: "", stderr: "" }
    }
    throw new Error(`Unexpected command: ${cmd}`)
  }) as any)

  const result = await tool.run({ action: "deactivate" }, {} as any)
  assert.ok(ranPkexec)
  assert.match(result as string, /vía pkexec/i)
})

test("manage_sudo_mode run activate: success (ALL)", async () => {
  _setTestUserInfo(() => ({ username: "cristian" }))
  let ranPkexec = false
  _setTestExecFile((async (cmd: any, args: any) => {
    if (cmd === "pkexec") {
      assert.equal(args[0], "bash")
      assert.equal(args[1], "-c")
      assert.match(args[2], /cristian ALL=\(ALL\) NOPASSWD: ALL/)
      assert.match(args[2], /visudo -c -f/)
      ranPkexec = true
      return { stdout: "", stderr: "" }
    }
    throw new Error(`Unexpected command: ${cmd}`)
  }) as any)

  const result = await tool.run({ action: "activate" }, {} as any)
  assert.ok(ranPkexec)
  assert.match(result as string, /activado con éxito.*ALL/i)
})

test("manage_sudo_mode run activate: success (specific commands)", async () => {
  _setTestUserInfo(() => ({ username: "cristian" }))
  let ranPkexec = false
  _setTestExecFile((async (cmd: any, args: any) => {
    if (cmd === "pkexec") {
      assert.equal(args[0], "bash")
      assert.equal(args[1], "-c")
      assert.match(args[2], /cristian ALL=\(ALL\) NOPASSWD: \/usr\/bin\/systemctl, \/usr\/bin\/apt-get/)
      ranPkexec = true
      return { stdout: "", stderr: "" }
    }
    throw new Error(`Unexpected command: ${cmd}`)
  }) as any)

  const result = await tool.run({ action: "activate", commands: ["/usr/bin/systemctl", "/usr/bin/apt-get"] }, {} as any)
  assert.ok(ranPkexec)
  assert.match(result as string, /systemctl, \/usr\/bin\/apt-get/i)
})

test("manage_sudo_mode run activate: error on invalid username", async () => {
  _setTestUserInfo(() => ({ username: "bad;user" }))
  await assert.rejects(
    async () => {
      await tool.run({ action: "activate" }, {} as any)
    },
    /Nombre de usuario inválido/i
  )
})

test("manage_sudo_mode run activate: error on non-absolute command paths", async () => {
  _setTestUserInfo(() => ({ username: "cristian" }))
  await assert.rejects(
    async () => {
      await tool.run({ action: "activate", commands: ["systemctl"] }, {} as any)
    },
    /ruta absoluta/i
  )
})

test("manage_sudo_mode run activate: error on invalid command characters", async () => {
  _setTestUserInfo(() => ({ username: "cristian" }))
  await assert.rejects(
    async () => {
      await tool.run({ action: "activate", commands: ["/usr/bin/sys,temctl"] }, {} as any)
    },
    /Caracteres inválidos/i
  )
})
