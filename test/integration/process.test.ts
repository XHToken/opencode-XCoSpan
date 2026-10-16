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
      const decoder = new TextDecoder()
      let output = ""
      try {
        while (!output.includes("\n")) {
          const chunk = await reader.read()
          if (chunk.done) throw new Error("Launcher exited before reporting its child PID")
          output += decoder.decode(chunk.value, { stream: true })
        }
      } finally {
        reader.releaseLock()
      }
      const childID = Number(output.slice(0, output.indexOf("\n")).trim())
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
