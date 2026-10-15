import { expect, spyOn, test } from "bun:test"
import * as dns from "node:dns"
import { publicWebTransport } from "../../src/network"

test.each([
  "http://127.0.0.1",
  "http://localhost",
  "http://2130706433",
  "http://0x7f000001",
  "http://[::1]",
  "http://[::ffff:127.0.0.1]",
  "http://169.254.169.254",
  "http://10.0.0.1",
  "http://[fe80::1]",
])("public web transport rejects %s before a response", async (url) => {
  const transport = publicWebTransport()
  try {
    await expect(transport.fetch(url)).rejects.toThrow(/not allowed/)
  } finally {
    transport.close()
  }
})

test.each([
  { addresses: [{ address: "127.0.0.1", family: 4 }] },
  {
    addresses: [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  },
])("connection-time DNS rejects private answers: %j", async ({ addresses }) => {
  const transport = publicWebTransport()
  const lookup = spyOn(dns, "lookup").mockImplementation(((
    _host: string,
    options: dns.LookupAllOptions,
    callback: (...args: unknown[]) => void,
  ) => {
    expect(options.all).toBe(true)
    callback(null, addresses)
  }) as typeof dns.lookup)
  try {
    await expect(transport.fetch("http://untrusted-dns.test")).rejects.toThrow(/not allowed/)
    expect(lookup).toHaveBeenCalledTimes(1)
    expect(lookup.mock.calls[0]?.[1]).toMatchObject({ all: true })
  } finally {
    lookup.mockRestore()
    transport.close()
  }
})

test("public web transport forwards cancellation before dispatch", async () => {
  const transport = publicWebTransport()
  const cancel = new AbortController()
  cancel.abort(new Error("User cancelled"))
  try {
    await expect(transport.fetch("https://example.com", { signal: cancel.signal })).rejects.toThrow()
  } finally {
    transport.close()
  }
})
