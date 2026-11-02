import { sendTyping } from "../protocol/api/api.js";
import { TypingStatus } from "../protocol/api/types.js";
import { logger } from "../protocol/util/logger.js";

/**
 * The WeChat "typing" bubble.
 *
 * WeChat only shows the indicator for a few seconds per request, so it is
 * refreshed on a timer for as long as the turn runs. A deployment whose
 * `getConfig` never yielded a typing ticket simply gets no indicator — that is
 * cosmetic, so every failure here is logged and swallowed.
 */

/** How often the indicator is re-sent while a turn is running. */
const KEEPALIVE_INTERVAL_MS = 5_000;

export interface TypingIndicatorOptions {
  baseUrl: string;
  token?: string;
  /** Weixin user id the indicator is shown to. */
  to: string;
  /** `typing_ticket` from `getConfig`; absent means "no indicator". */
  ticket: string | undefined;
}

/** Keeps the typing bubble alive for the duration of one turn. */
export class TypingIndicator {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(private readonly options: TypingIndicatorOptions) {}

  /** Start the indicator (no-op without a ticket). */
  start(): void {
    if (this.options.ticket === undefined || this.options.ticket === "") return;
    this.stopped = false;
    void this.send(TypingStatus.TYPING);
    this.timer = setInterval(() => {
      void this.send(TypingStatus.TYPING);
    }, KEEPALIVE_INTERVAL_MS);
    // Never keep the process alive just for a cosmetic indicator.
    this.timer.unref?.();
  }

  /** Cancel the indicator and stop refreshing it. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.options.ticket === undefined || this.options.ticket === "") return;
    await this.send(TypingStatus.CANCEL);
  }

  private async send(status: number): Promise<void> {
    const ticket = this.options.ticket;
    if (ticket === undefined || ticket === "") return;
    try {
      await sendTyping({
        baseUrl: this.options.baseUrl,
        ...(this.options.token === undefined ? {} : { token: this.options.token }),
        body: {
          ilink_user_id: this.options.to,
          typing_ticket: ticket,
          status,
        },
      });
    } catch (err) {
      logger.debug(`typing: send failed (ignored): ${String(err)}`);
    }
  }
}
