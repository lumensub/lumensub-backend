import type { Logger } from '../logger.js';
import type { DomainEvent } from '../stellar/events.js';

export type NotificationKind = 'charge_failed' | 'subscription_cancelled' | 'subscription_completed';

export interface Notification {
  kind: NotificationKind;
  merchant: string;
  subscriptionId: string;
  subject: string;
  text: string;
}

export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/** Writes notifications to the log. The default, and what tests use. */
export class LogNotifier implements Notifier {
  constructor(private readonly log: Logger) {}

  async send(n: Notification): Promise<void> {
    this.log.info({ notification: n }, n.subject);
  }
}

export type EmailTransport = (message: { to: string; subject: string; text: string }) => Promise<void>;

/**
 * Sends notifications by email through whatever transport you pass in (an SMTP
 * client, an email API). The backend does not ship one, so there is no default.
 */
export class EmailNotifier implements Notifier {
  constructor(
    private readonly transport: EmailTransport,
    private readonly addressFor: (merchant: string) => Promise<string | null>,
  ) {}

  async send(n: Notification): Promise<void> {
    const to = await this.addressFor(n.merchant);
    if (!to) return;
    await this.transport({ to, subject: n.subject, text: n.text });
  }
}

/** Which events a merchant should hear about outside of webhooks. */
export function notificationFor(event: DomainEvent, merchant: string): Notification | null {
  switch (event.type) {
    case 'chg_fail':
      return {
        kind: 'charge_failed',
        merchant,
        subscriptionId: event.subId.toString(),
        subject: `Charge failed for subscription ${event.subId}`,
        text: `The charge for subscription ${event.subId} failed (${event.reason}). It is now ${event.status.replace('_', ' ')}.`,
      };
    case 'cancelled':
      return {
        kind: 'subscription_cancelled',
        merchant,
        subscriptionId: event.subId.toString(),
        subject: `Subscription ${event.subId} was cancelled`,
        text: `Subscription ${event.subId} was cancelled by ${event.by}.`,
      };
    default:
      return null;
  }
}
