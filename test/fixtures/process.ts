async function windowsProcessTree(pid: number): Promise<number[]> {
  const query = Bun.spawn(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId, ParentProcessId | ConvertTo-Json -Compress",
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    query.exited,
    new Response(query.stdout).text(),
    new Response(query.stderr).text(),
  ])
  if (code !== 0) throw new Error("Could not inspect isolated process tree: " + stderr)
  const processes = JSON.parse(stdout) as { ProcessId: number; ParentProcessId: number }[]
  const pids = new Set([pid])
  let size: number
  do {
    size = pids.size
    for (const child of processes) if (pids.has(child.ParentProcessId)) pids.add(child.ProcessId)
  } while (pids.size !== size)
  return [...pids]
}

function exited(pid: number) {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true
    throw error
  }
}

/** Windows launchers stay attached and use taskkill; POSIX hosts use detached process groups. */
export async function stopHostProcess(host: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
  if (host.exitCode === null && host.signalCode === null) {
    if (process.platform === "win32") {
      const pids = await windowsProcessTree(host.pid)
      const kill = Bun.spawn(["taskkill.exe", "/PID", String(host.pid), "/T", "/F"], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, stdout, stderr] = await Promise.all([
        kill.exited,
        new Response(kill.stdout).text(),
        new Response(kill.stderr).text(),
      ])
      // A descendant can exit naturally while taskkill is terminating the tree.
      // Accept that race only when every process from the snapshot has exited.
      if (code !== 0 && !pids.every(exited))
        throw new Error("Could not stop isolated host tree: " + stdout + stderr)
    } else process.kill(-host.pid, signal)
  }
  await host.exited
}
