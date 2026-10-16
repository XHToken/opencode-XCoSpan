import { platform } from "node:process"
import { Terminal } from "@xterm/headless"
import { stopHostProcess } from "../fixtures/process"

export function terminal(args: string[], env: Record<string, string | undefined>, cols = 150, rows = 50) {
  const display = new Terminal({ cols, rows, allowProposedApi: true })
  const process = Bun.spawn(args, {
    env: { ...env, TERM: "xterm-256color" },
    terminal: {
      cols,
      rows,
      data(_terminal, data) {
        display.write(data)
      },
    },
  })
  display.onData((data) => process.terminal!.write(data))
  return {
    process,
    write: (data: string) => process.terminal!.write(data),
    resize(cols: number, rows: number) {
      display.resize(cols, rows)
      process.terminal!.resize(cols, rows)
    },
    screen: () => {
      const buffer = display.buffer.active
      return Array.from(
        { length: display.rows },
        (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true, 0, display.cols) ?? "",
      ).join("\n")
    },
    colorCount(color: { palette: number; rgb: number }) {
      const buffer = display.buffer.active
      let count = 0
      for (let y = 0; y < display.rows; y++) {
        const line = buffer.getLine(buffer.viewportY + y)
        for (let x = 0; x < display.cols; x++) {
          const cell = line?.getCell(x)
          if (!cell) continue
          const foreground = cell.getChars().trim().length > 0
          const background = cell.getChars() !== "█"
          if (
            (foreground &&
              ((cell.isFgPalette() && cell.getFgColor() === color.palette) ||
                (cell.isFgRGB() && cell.getFgColor() === color.rgb))) ||
            (background &&
              ((cell.isBgPalette() && cell.getBgColor() === color.palette) ||
                (cell.isBgRGB() && cell.getBgColor() === color.rgb)))
          )
            count++
        }
      }
      return count
    },
    async close(signal?: "SIGTERM" | "SIGKILL") {
      if (platform === "win32") await stopHostProcess(process, signal)
      else {
        process.kill(signal)
        await process.exited
      }
      process.terminal?.close()
      display.dispose()
    },
  }
}
