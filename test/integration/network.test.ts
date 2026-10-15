import { expect, test } from "bun:test"
import { publicWebTransport } from "../../src/network"

// Opt in: these checks use the real public HTTP test service.
const publicTest = test.skipIf(!process.env.XCOSPAN_PUBLIC_WEB_TEST)

publicTest(
  "public redirect cannot reach a local service",
  async () => {
    let fetched = 0
    const local = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        fetched++
        return new Response("PRIVATE_HTTP_DATA")
      },
    })
    const url = new URL("https://httpbin.org/redirect-to")
    url.searchParams.set("url", local.url.href)
    const transport = publicWebTransport()
    try {
      const control = await fetch(url, { redirect: "manual" })
      expect(control.status).toBe(302)
      expect(control.headers.get("location")).toBe(local.url.href)
      await expect(transport.fetch(url)).rejects.toThrow(/not allowed/)
      expect(fetched).toBe(0)
    } finally {
      transport.close()
      local.stop(true)
    }
  },
  30000,
)

publicTest(
  "cancellation interrupts an active public response body",
  async () => {
    const transport = publicWebTransport()
    const cancel = new AbortController()
    try {
      const response = await transport.fetch("https://httpbingo.org/drip?duration=10&numbytes=100&delay=0", {
        signal: cancel.signal,
      })
      expect(response.status).toBe(200)
      const reader = response.body!.getReader()
      expect((await reader.read()).done).toBe(false)
      cancel.abort(new Error("User cancelled"))
      await expect(
        (async () => {
          while (!(await reader.read()).done) {
            /* Drain any already-buffered bytes. */
          }
        })(),
      ).rejects.toThrow()
    } finally {
      transport.close()
    }
  },
  30000,
)
