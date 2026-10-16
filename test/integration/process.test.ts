import { expect, test } from "bun:test"
import { stopHostProcess } from "../fixtures/process"

test.skipIf(process.platform !== "win32")(
  "Windows teardown stops the launcher and its live descendants",
  async () => {
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        'const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]); console.log(child.pid); setInterval(() => {}, 1000)',
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    try {
      const reader = host.stdout.getReader()
      const first = await reader.read()
      const childID = Number(new TextDecoder().decode(first.value).trim())
      reader.releaseLock()
      expect(Number.isInteger(childID) && childID > 0).toBe(true)
      expect(() => process.kill(childID, 0)).not.toThrow()
      await stopHostProcess(host)
      for (const pid of [host.pid, childID]) {
        let code: string | undefined
        try {
          process.kill(pid, 0)
        } catch (error) {
          code = (error as NodeJS.ErrnoException).code
        }
        expect(code).toBe("ESRCH")
      }
    } finally {
      await stopHostProcess(host)
    }
  },
  30000,
)
