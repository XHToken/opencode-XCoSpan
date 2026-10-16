import { Predicate } from "effect"

// Match the native error and its target; transport and storage errors must remain visible.
export function isMissingSession(error: unknown, sessionID: string): boolean {
  return (
    Predicate.isTagged(error, "Session.NotFoundError") &&
    "sessionID" in error &&
    error.sessionID === sessionID
  )
}

// Expected user actions can fail without concealing the reason behind rpc.internal.
export class ActionError extends Error {}

export async function exposeAction<T>(
  action: () => Promise<T>,
  context: { error(type: "action", message: string, data: Record<string, never>): unknown },
): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof ActionError) throw context.error("action", error.message, {})
    throw error
  }
}
