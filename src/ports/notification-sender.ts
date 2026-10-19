/**
 * The delivery channel, as the dispatcher sees it (SRS 3.2 "Rate limits"; FR-017).
 *
 * A port rather than a Telegram client, for the same reason the source adapters are: the
 * dispatcher's contract — claim, send, record — is testable against a fake, and the only
 * channel-specific code is the sender. `NOTIFICATION_SENDER=noop` (SRS 6.8's spirit, ENG-008)
 * stays possible: no delivery path may depend on a channel being reachable.
 */
export interface NotificationMessage {
  notificationId: string;
  /** Destination-independent text rendered from stored evidence (SRS 3.2 content list). */
  text: string;
  /** The job the message is about. */
  jobId: string;
}

/**
 * What the channel did.
 *
 * `retryable` is the sender's judgement, not the dispatcher's: only the channel knows whether a
 * failure was transient (a 429, a timeout, a 5xx) or permanent (a blocked chat, a deleted bot).
 * `retryAfterSeconds` is the channel's own hint when it gives one.
 */
export type SendOutcome =
  | { delivered: true }
  | { delivered: false; retryable: boolean; reason: string; retryAfterSeconds?: number | null };

export interface NotificationSender {
  send(message: NotificationMessage): Promise<SendOutcome>;
}
