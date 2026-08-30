/**
 * Canonical Notification Copy & Natural Language Presentation Service.
 * Decouples deterministic domain decisions from natural language presentation.
 * Provides deterministic, non-repetitive conversational variation without Math.random().
 */

export type CopyCategory =
  | "task_reminder"
  | "task_due"
  | "task_overdue"
  | "followup_initial"
  | "followup_retry"
  | "followup_after_snooze"
  | "study_session"
  | "exam_warning"
  | "commitment"
  | "daily_briefing_morning"
  | "daily_briefing_evening"
  | "system_configuration_issue";

export interface TaskReminderContext {
  taskTitle: string;
  dueTimeStr: string;
  isUrgent?: boolean;
  attemptCount?: number;
}

export interface FollowUpContext {
  taskTitle: string;
  attemptCount: number;
  wasSnoozed?: boolean;
  dueTimeStr?: string;
  snoozeDurationMinutes?: number;
}

export interface OverdueTaskContext {
  taskTitle: string;
  dueTimeStr?: string;
}

export interface StudySessionContext {
  courseName: string;
  topicName?: string;
  startsInMinutes?: number;
}

export interface ExamWarningContext {
  courseName: string;
  assessmentTitle: string;
  daysRemaining: number;
  weakTopics?: string[];
}

export interface DailyBriefingContext {
  displayName?: string | null;
  tasksCount: number;
  taskTitles?: string[];
  calendarEventsCount?: number;
  openTasksCount?: number;
}

export class ResponseCopyService {
  /**
   * Generates a natural, non-repetitive task reminder.
   * Never begins with "Reminder:".
   */
  composeTaskReminder(
    taskId: string,
    ctx: TaskReminderContext,
    dateSeed?: string
  ): { text: string; voiceText: string } {
    const variants = [
      (c: TaskReminderContext) =>
        `You wanted to take care of "${c.taskTitle}" at ${c.dueTimeStr} — just making sure it doesn't slip through.`,
      (c: TaskReminderContext) =>
        `Quick heads-up: "${c.taskTitle}" is coming up at ${c.dueTimeStr}.`,
      (c: TaskReminderContext) =>
        `Your task "${c.taskTitle}" is scheduled for ${c.dueTimeStr}. Reply "done" once handled, or "snooze 30" to delay.`,
      (c: TaskReminderContext) =>
        `"${c.taskTitle}" is on your schedule for ${c.dueTimeStr}. Let me know if you need more time!`,
      (c: TaskReminderContext) =>
        `Approaching on your schedule: "${c.taskTitle}" at ${c.dueTimeStr}.`,
    ];

    const seed = `${taskId}_${ctx.attemptCount ?? 0}_reminder_${dateSeed || ""}`;
    const index = this.getDeterministicIndex(seed, variants.length);
    const text = variants[index](ctx);
    const voiceText = this.sanitizeForVoice(text);

    return { text, voiceText };
  }

  /**
   * Generates a context-aware follow-up check-in.
   * Adjusts tone for initial check, retry after snooze, or multiple attempts.
   * Never begins with "Checking in:".
   */
  composeFollowUp(
    followUpId: string,
    ctx: FollowUpContext,
    dateSeed?: string
  ): { text: string; voiceText: string } {
    if (ctx.wasSnoozed) {
      const snoozeVariants = [
        (c: FollowUpContext) =>
          `You asked me to bring this back up now — were you able to finish "${c.taskTitle}"?`,
        (c: FollowUpContext) =>
          `Checking back in as requested on "${c.taskTitle}". Did you manage to take care of it?`,
        (c: FollowUpContext) =>
          `Bringing "${c.taskTitle}" back to your attention after your snooze. Is that all set?`,
      ];
      const index = this.getDeterministicIndex(`${followUpId}_snooze_${ctx.attemptCount}`, snoozeVariants.length);
      const text = snoozeVariants[index](ctx);
      return { text, voiceText: this.sanitizeForVoice(text) };
    }

    if (ctx.attemptCount > 1) {
      const retryVariants = [
        (c: FollowUpContext) =>
          `Coming back to "${c.taskTitle}" once more — has that been taken care of?`,
        (c: FollowUpContext) =>
          `Following up again on "${c.taskTitle}". Do you want to mark it done, snooze it, or drop it?`,
        (c: FollowUpContext) =>
          `I know you had "${c.taskTitle}" open earlier. Did you get a chance to finish it?`,
      ];
      const index = this.getDeterministicIndex(`${followUpId}_retry_${ctx.attemptCount}`, retryVariants.length);
      const text = retryVariants[index](ctx);
      return { text, voiceText: this.sanitizeForVoice(text) };
    }

    const initialVariants = [
      (c: FollowUpContext) => `Did you get a chance to finish "${c.taskTitle}"?`,
      (c: FollowUpContext) => `How did "${c.taskTitle}" go? Let me know if you're all done.`,
      (c: FollowUpContext) => `Were you able to take care of "${c.taskTitle}"?`,
      (c: FollowUpContext) => `Just seeing how you got on with "${c.taskTitle}" — is that completed?`,
    ];

    const index = this.getDeterministicIndex(`${followUpId}_initial_${dateSeed || ""}`, initialVariants.length);
    const text = initialVariants[index](ctx);
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Generates a proactive message for an overdue task.
   */
  composeOverdueTask(
    taskId: string,
    ctx: OverdueTaskContext
  ): { text: string; voiceText: string } {
    const variants = [
      (c: OverdueTaskContext) =>
        `"${c.taskTitle}" has passed its scheduled deadline. Would you like to mark it done, reschedule it, or keep it open?`,
      (c: OverdueTaskContext) =>
        `Looks like "${c.taskTitle}" slipped past its deadline. What would you like to do with it?`,
      (c: OverdueTaskContext) =>
        `"${c.taskTitle}" is still pending after its deadline. Let me know if you want to reschedule it for later today.`,
    ];

    const index = this.getDeterministicIndex(`${taskId}_overdue`, variants.length);
    const text = variants[index](ctx);
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Generates a study session alert.
   */
  composeStudySessionAlert(
    sessionId: string,
    ctx: StudySessionContext
  ): { text: string; voiceText: string } {
    const mins = ctx.startsInMinutes ?? 15;
    const topicStr = ctx.topicName ? ` on "${ctx.topicName}"` : "";

    const variants = [
      () =>
        `Your ${ctx.courseName} study session${topicStr} begins in ${mins} minutes. Ready to get into it?`,
      () =>
        `You've got ${ctx.courseName} revision${topicStr} coming up in about ${mins} minutes.`,
      () =>
        `Time to start wrapping up what you're doing — your ${ctx.courseName} focus session begins in ${mins} minutes.`,
    ];

    const index = this.getDeterministicIndex(`${sessionId}_study_${mins}`, variants.length);
    const text = variants[index]();
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Generates an upcoming assessment/exam warning with mastery context.
   */
  composeExamWarning(
    _assessmentId: string,
    ctx: ExamWarningContext
  ): { text: string; voiceText: string } {
    const daysStr = ctx.daysRemaining === 1 ? "tomorrow" : `in ${ctx.daysRemaining} days`;
    let suffix = "";

    if (ctx.weakTopics && ctx.weakTopics.length > 0) {
      const topWeak = ctx.weakTopics.slice(0, 2).map((t) => `"${t}"`).join(" and ");
      suffix = ` You still have ${topWeak} marked for review — want me to schedule a targeted practice block?`;
    }

    const text = `Your ${ctx.courseName} ${ctx.assessmentTitle} is ${daysStr}.${suffix}`;
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Generates morning agenda daily briefing.
   */
  composeMorningBriefing(
    _userId: string,
    ctx: DailyBriefingContext,
    agendaLines?: string[]
  ): { text: string; voiceText: string } {
    const nameStr = ctx.displayName ? ` ${ctx.displayName}` : "";
    let body = "";

    if (agendaLines && agendaLines.length > 0) {
      body = `Here is what is currently on your plate today:\n${agendaLines.join("\n")}\n\nLet me know what you'd like to prioritize!`;
    } else {
      body = `You have a clear schedule today. Tell me what's on your mind and I'll keep track of it!`;
    }

    const text = `Good morning${nameStr}! ☀️\n\n${body}`;
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Generates evening wrap-up check-in.
   */
  composeEveningCheckIn(
    _userId: string,
    ctx: DailyBriefingContext
  ): { text: string; voiceText: string } {
    const openCount = ctx.openTasksCount ?? ctx.tasksCount;
    const text = `Quick evening check-in — you have ${openCount} item(s) open from today. Reply "done [item]" or let me know if anything should move to tomorrow.`;
    return { text, voiceText: this.sanitizeForVoice(text) };
  }

  /**
   * Formats technical errors into polite, humanized secretary messages.
   * Never exposes raw database errors, HTTP status codes, or permission strings.
   */
  formatUserErrorMessage(technicalError: string): string {
    const lower = technicalError.toLowerCase();

    if (lower.includes("calendar") || lower.includes("oauth") || lower.includes("reauth")) {
      return "Calendar access needs to be reconnected before I can check your schedule. You can use /auth/google to reconnect.";
    }

    if (lower.includes("rate limit") || lower.includes("too many requests")) {
      return "I'm receiving a lot of requests right now. I'll hold your update and process it in just a moment.";
    }

    if (lower.includes("permission") || lower.includes("database") || lower.includes("timeout")) {
      return "I couldn't process that update just now. I'll retry automatically in a moment.";
    }

    return "I ran into a temporary issue handling that, but I'll try again shortly.";
  }

  /**
   * Sanitizes markdown text for smooth, natural voice synthesis.
   * Strips bold/italic markers, brackets, list bullets, and decorative emojis.
   */
  sanitizeForVoice(text: string): string {
    return text
      // Remove URLs or markdown links [label](url) -> label
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove inline code ticks
      .replace(/`([^`]+)`/g, "$1")
      // Remove markdown bold/italic asterisks & underscores
      .replace(/[*_~]/g, "")
      // Remove bullets / headers / quotes
      .replace(/^[•\->#\s]+/gm, "")
      // Remove emojis & decorative symbols
      .replace(/[\p{Extended_Pictographic}\u2600-\u26FF\u2700-\u27BF]/gu, "")
      // Clean up duplicate spaces and newlines
      .replace(/\n+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  /**
   * Stable deterministic hashing function for reproducible variant selection.
   */
  private getDeterministicIndex(seed: string, totalVariants: number): number {
    if (totalVariants <= 1) return 0;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      const char = seed.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash |= 0; // Convert to 32bit integer
    }
    return Math.abs(hash) % totalVariants;
  }
}
