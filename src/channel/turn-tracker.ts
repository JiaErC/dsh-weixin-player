import type { HostContext } from "../dsh/services.js";

/**
 * Collects one turn's assistant output from the session event bus.
 *
 * The channel needs the reply text of the turn it just started. DSH's durable
 * truth is the session log, and the sanctioned live read is a `session/event`
 * subscription, so this tracker subscribes once and hands each waiter the
 * `assistant/message` texts that land inside its own turn.
 */

/** Why a turn stopped. */
export type TurnEndKind =
  | "completed"
  | "aborted"
  | "blocked"
  | "error"
  | "max-tokens"
  | "interrupted"
  | "forked";

/** What one driven turn produced. */
export interface TurnOutcome {
  /** Assistant text blocks, one entry per step that produced visible text. */
  texts: string[];
  /** How the turn ended; undefined when the wait timed out. */
  kind: TurnEndKind | undefined;
  /** Provider failure message when `kind` is `error`. */
  error: string | undefined;
  /** Tool names invoked during the turn, in order. */
  toolCalls: string[];
  /** Milliseconds from `begin()` to settlement. */
  durationMs: number;
}

interface Waiter {
  sessionId: string;
  startedAt: number;
  texts: string[];
  toolCalls: string[];
  settle: (outcome: TurnOutcome) => void;
}

/** Minimal shape of the events this tracker reads. */
interface LooseEvent {
  type?: string;
  data?: {
    reason?: { kind?: string; error?: { message?: string; code?: string } };
    message?: { content?: Array<{ type?: string; text?: string }> };
    name?: string;
  };
}

function textOf(content: Array<{ type?: string; text?: string }> | undefined): string {
  if (content === undefined) return "";
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
}

/**
 * Tracks at most one in-flight turn per session and buffers its output.
 *
 * `begin()` must be called immediately before `agent.followup()`, from the same
 * serialized queue that drains that session, so the next `turn/end` belongs to
 * this waiter.
 */
export class TurnTracker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly dispose: () => void;

  constructor(ctx: HostContext) {
    this.dispose = ctx.on("session/event", ((session: unknown, event: unknown) => {
      const sessionId = (session as { id?: unknown } | undefined)?.id;
      if (typeof sessionId !== "string") return;
      const waiter = this.waiters.get(sessionId);
      if (waiter === undefined) return;
      this.observe(waiter, event as LooseEvent);
    }) as never);
  }

  private observe(waiter: Waiter, event: LooseEvent): void {
    switch (event.type) {
      case "assistant/message": {
        const text = textOf(event.data?.message?.content);
        if (text.trim() !== "") waiter.texts.push(text);
        return;
      }
      case "tool/call": {
        const name = event.data?.name;
        if (typeof name === "string" && name !== "") waiter.toolCalls.push(name);
        return;
      }
      case "turn/end": {
        const reason = event.data?.reason;
        const kind = (reason?.kind ?? "completed") as TurnEndKind;
        const error = reason?.error;
        this.settle(waiter, {
          kind,
          error: error === undefined ? undefined : (error.message ?? error.code ?? "unknown error"),
        });
        return;
      }
      default:
        return;
    }
  }

  private settle(
    waiter: Waiter,
    tail: { kind: TurnEndKind | undefined; error: string | undefined },
  ): void {
    if (this.waiters.get(waiter.sessionId) === waiter) {
      this.waiters.delete(waiter.sessionId);
    }
    waiter.settle({
      texts: waiter.texts,
      kind: tail.kind,
      error: tail.error,
      toolCalls: waiter.toolCalls,
      durationMs: Date.now() - waiter.startedAt,
    });
  }

  /**
   * Arm a waiter for the next turn of `sessionId`.
   *
   * Calling it twice for the same session settles the previous waiter with
   * whatever it had collected, so a lost `turn/end` can never wedge the queue.
   */
  begin(sessionId: string): Promise<TurnOutcome> {
    const previous = this.waiters.get(sessionId);
    if (previous !== undefined) {
      this.settle(previous, { kind: "interrupted", error: undefined });
    }

    return new Promise<TurnOutcome>((resolve) => {
      const waiter: Waiter = {
        sessionId,
        startedAt: Date.now(),
        texts: [],
        toolCalls: [],
        settle: resolve,
      };
      this.waiters.set(sessionId, waiter);
    });
  }

  /** Disarm a waiter that will never receive a `turn/end` (failed follow-up). */
  abort(sessionId: string): void {
    const waiter = this.waiters.get(sessionId);
    if (waiter === undefined) return;
    this.settle(waiter, { kind: "aborted", error: undefined });
  }

  /** Stop listening; called when the channel unmounts. */
  stop(): void {
    this.dispose();
    for (const waiter of [...this.waiters.values()]) {
      this.settle(waiter, { kind: "aborted", error: undefined });
    }
  }
}
