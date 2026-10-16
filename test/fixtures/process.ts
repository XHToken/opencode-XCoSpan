/** Windows launchers stay attached and use taskkill; POSIX hosts use detached process groups. */
export async function stopHostProcess(host: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (host.exitCode === null && host.signalCode === null) {
    if (process.platform === "win32") {
      const kill = Bun.spawn(["taskkill.exe", "/PID", String(host.pid), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        kill.exited,
        new Response(kill.stdout).text(),
        new Response(kill.stderr).text(),
      ])
      if (code !== 0) throw new Error("Could not stop isolated host tree: " + stdout + stderr)
    } else process.kill(-host.pid, signal)
  }
  await host.exited
}
