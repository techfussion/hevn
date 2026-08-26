import { logger } from "../../utils/logger";
import type {
  User,
  NotificationDecision,
  NotificationDigest,
} from "../../types/domain";
import type { ChannelCapabilities } from "../../adapters/MessagingAdapter";
import type { NotificationDeduplicationService } from "./NotificationDeduplicationService";

export interface NotificationEvaluationContext {
  id: string;
  category: "reminder" | "follow_up" | "study_session" | "daily_briefing" | "recurring_task";
  priority?: "low" | "medium" | "high" | "urgent";
  taskId?: string;
  title: string;
  text: string;
  buttons?: Array<{ label: string; action: string }>;
  channelCapabilities: ChannelCapabilities;
  incomingModality?: "text" | "voice";
}

export interface NotificationPolicyConfig {
  maxNotificationsPerHour?: number; // default 5
  minFollowUpGapMinutes?: number; // default 15
  maxAutoVoiceLength?: number; // default 500 chars
}

export class NotificationPolicyService {
  private maxNotificationsPerHour: number;
  private minFollowUpGapMinutes: number;
  private maxAutoVoiceLength: number;

  constructor(
    private dedupService?: NotificationDeduplicationService,
    config?: NotificationPolicyConfig
  ) {
    this.maxNotificationsPerHour = config?.maxNotificationsPerHour ?? 5;
    this.minFollowUpGapMinutes = config?.minFollowUpGapMinutes ?? 15;
    this.maxAutoVoiceLength = config?.maxAutoVoiceLength ?? 500;
  }

  /**
   * Evaluates notification eligibility, quiet hours, anti-nagging gap, rate limits, and modality.
   */
  async evaluatePolicy(
    user: User,
    ctx: NotificationEvaluationContext,
    now: Date = new Date()
  ): Promise<NotificationDecision> {
    return this.evaluate(user, ctx, now);
  }

  /**
   * Evaluates notification eligibility, quiet hours, anti-nagging gap, rate limits, and modality.
   */
  async evaluate(
    user: User,
    ctx: NotificationEvaluationContext,
    now: Date = new Date()
  ): Promise<NotificationDecision> {
    const isUrgent = ctx.priority === "urgent";

    // 1. Quiet Hours Evaluation
    if (!isUrgent && user.quietHoursStart && user.quietHoursEnd) {
      const inQuietHours = this.isWithinQuietHours(
        now,
        user.timezone || "UTC",
        user.quietHoursStart,
        user.quietHoursEnd
      );

      if (inQuietHours) {
        const resumeTime = this.calculateQuietHoursEnd(
          now,
          user.timezone || "UTC",
          user.quietHoursEnd
        );
        logger.info(
          { userId: user.id, category: ctx.category, resumeTime },
          "Notification deferred: user is currently within quiet hours"
        );
        return {
          eligible: false,
          action: "defer",
          reason: "quiet_hours",
          deferredUntil: resumeTime.toISOString(),
          deliveryModality: "text",
        };
      }
    }

    // 2. Anti-Nagging Gap Check (for follow-ups on the same task)
    if (this.dedupService && ctx.category === "follow_up" && ctx.taskId && !isUrgent) {
      const lastFollowUp = await this.dedupService.getLastNotificationTimestamp(
        user.id,
        `followup:${ctx.taskId}`
      );
      if (lastFollowUp) {
        const diffMinutes = (now.getTime() - lastFollowUp.getTime()) / (1000 * 60);
        if (diffMinutes < this.minFollowUpGapMinutes) {
          const deferredUntil = new Date(
            lastFollowUp.getTime() + this.minFollowUpGapMinutes * 60 * 1000
          ).toISOString();
          logger.info(
            { userId: user.id, taskId: ctx.taskId, diffMinutes },
            "Notification deferred: anti-nagging minimum gap interval"
          );
          return {
            eligible: false,
            action: "defer",
            reason: "anti_nagging_gap",
            deferredUntil,
            deliveryModality: "text",
          };
        }
      }
    }

    // 3. Hourly Rate Limiting Check
    if (this.dedupService && !isUrgent) {
      const recentCount = await this.dedupService.getRecentNotificationCount(user.id, 60);
      if (recentCount >= this.maxNotificationsPerHour) {
        const deferredUntil = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
        logger.warn(
          { userId: user.id, recentCount, max: this.maxNotificationsPerHour },
          "Notification deferred: user exceeded hourly notification rate limit"
        );
        return {
          eligible: false,
          action: "defer",
          reason: "rate_limit_exceeded",
          deferredUntil,
          deliveryModality: "text",
        };
      }
    }

    // 4. Modality Determination
    const deliveryModality = this.determineModality(user, ctx);

    // 5. Eligible for Immediate Delivery
    return {
      eligible: true,
      action: "deliver",
      reason: "eligible",
      deliveryModality,
      consolidatedPayload: {
        text: ctx.text,
        buttons: ctx.buttons,
      },
    };
  }

  /**
   * Formats a collection of due notifications into a single consolidated digest.
   */
  formatDigest(digest: NotificationDigest): { text: string; buttons?: Array<{ label: string; action: string }> } {
    if (digest.items.length === 0) {
      return { text: digest.formattedText || "No active notifications." };
    }

    const lines: string[] = [
      `🔔 **You have ${digest.items.length} updates:**`,
      "",
    ];

    for (let i = 0; i < digest.items.length; i++) {
      const item = digest.items[i];
      let prefix = "•";
      if (item.type === "reminder") prefix = "⏰ [Reminder]";
      if (item.type === "follow_up") prefix = "📋 [Follow-Up]";
      if (item.type === "study_session") prefix = "📚 [Study Session]";
      if (item.type === "recurring_task") prefix = "🔄 [Recurring]";

      let dueStr = "";
      if (item.dueAt) {
        dueStr = ` (due ${new Date(item.dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`;
      }

      lines.push(`${prefix} ${item.title}${dueStr}`);
    }

    lines.push("");
    lines.push("Reply with your updates or 'done' to mark completed.");

    return {
      text: lines.join("\n"),
    };
  }

  private determineModality(user: User, ctx: NotificationEvaluationContext): "text" | "voice" {
    if (!ctx.channelCapabilities.audioOutput) {
      return "text";
    }

    if (user.responseMode === "text" || user.voiceEnabled === false) {
      return "text";
    }

    if (user.responseMode === "voice") {
      return "voice";
    }

    // Auto mode: produce voice if incoming modality was voice and text length <= maxAutoVoiceLength
    if (user.responseMode === "auto") {
      if (ctx.incomingModality === "voice" && ctx.text.length <= this.maxAutoVoiceLength) {
        return "voice";
      }
      return "text";
    }

    return "text";
  }

  /**
   * Evaluates if a given time is inside the user's quiet hours window.
   */
  isWithinQuietHours(
    now: Date,
    timezone: string,
    quietStartStr: string,
    quietEndStr: string
  ): boolean {
    try {
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
      const minute = parseInt(parts.find((p) => p.type === "minute")?.value || "0", 10);
      const currentMinutes = hour * 60 + minute;

      const [sHour, sMin] = quietStartStr.split(":").map((v) => parseInt(v, 10));
      const [eHour, eMin] = quietEndStr.split(":").map((v) => parseInt(v, 10));
      const startMinutes = sHour * 60 + (sMin || 0);
      const endMinutes = eHour * 60 + (eMin || 0);

      if (startMinutes > endMinutes) {
        // Overnight window (e.g. 22:00 to 07:00)
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
      } else {
        // Daytime window (e.g. 13:00 to 14:00)
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
      }
    } catch {
      return false;
    }
  }

  /**
   * Computes the exact Date when quiet hours will end.
   */
  calculateQuietHoursEnd(now: Date, timezone: string, quietEndStr: string): Date {
    try {
      const [eHour, eMin] = quietEndStr.split(":").map((v) => parseInt(v, 10));

      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      });

      const parts = formatter.formatToParts(now);
      const currentHour = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);

      const target = new Date(now);
      if (currentHour >= eHour) {
        target.setDate(target.getDate() + 1);
      }
      target.setHours(eHour, eMin || 0, 0, 0);
      return target;
    } catch {
      return new Date(now.getTime() + 60 * 60 * 1000);
    }
  }
}
