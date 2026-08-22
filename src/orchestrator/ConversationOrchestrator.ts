import { GemmaClient, ToolCall, ToolResult, extractReply } from "../core/gemma/GemmaClient";
import { taskTools } from "../core/gemma/tools";
import { buildSystemPrompt } from "../core/persona/systemPrompt";
import { TaskService } from "../core/tasks/TaskService";
import { withUserScope } from "../db/pool";
import type {
  ConversationTurn,
  User,
  FollowUpIntent,
  MemoryCategory,
  RecurrencePattern,
  UserMemory,
  FollowUp,
  Task,
} from "../types/domain";
import { InsightsService } from "../core/insights/InsightsService";
import { UserService } from "../core/tasks/UserService";
import { OnboardingService } from "../core/onboarding/OnboardingService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { RecurringTaskService } from "../core/recurring/RecurringTaskService";
import { MemoryService } from "../core/memory/MemoryService";
import { ProjectService } from "../core/projects/ProjectService";
import { logger } from "../utils/logger";

const MAX_HISTORY_TURNS = 6; // cap context; prevents unbounded token growth and cost

export class ConversationOrchestrator {
  private onboardingService: OnboardingService;
  private followUpService: FollowUpService;
  private recurringService: RecurringTaskService;
  private memoryService: MemoryService;
  private projectService: ProjectService;

  constructor(
    private gemma: GemmaClient,
    private taskService: TaskService,
    private userService: UserService,
    private insightsService: InsightsService,
    followUpService?: FollowUpService,
    recurringService?: RecurringTaskService,
    memoryService?: MemoryService,
    projectService?: ProjectService
  ) {
    this.onboardingService = new OnboardingService(this.userService, this.taskService);
    this.followUpService = followUpService || new FollowUpService();
    this.recurringService = recurringService || new RecurringTaskService();
    this.memoryService = memoryService || new MemoryService();
    this.projectService = projectService || new ProjectService();
  }

  /**
   * Main entry point: takes a user's raw message, returns the reply text
   * to send back. Handles onboarding state machine routing, tool-call
   * execution, and persists conversation history + task changes.
   */
  async handleMessage(user: User, rawText: string, correlationId?: string): Promise<string> {
    try {
      return await this.handleMessageInner(user, rawText, correlationId);
    } catch (err) {
      logger.error({ err, correlationId, userId: user.id }, "handleMessage failed, returning graceful fallback");
      return "Sorry, I hit a snag on my end just now — mind trying that again?";
    }
  }

  private async handleMessageInner(user: User, rawText: string, correlationId?: string): Promise<string> {
    const text = rawText.trim().slice(0, 2000);
    if (text.length === 0) {
      return "I didn't catch that — could you send it again?";
    }

    logger.debug({ correlationId, userId: user.id }, "Processing incoming message turn");

    // Route un-onboarded users through deterministic conversational state machine
    if (!user.onboarded || user.onboardingState !== "COMPLETED") {
      const reply = await this.onboardingService.handleOnboardingMessage(user, text);
      await this.persistTurn(user.id, "user", text);
      await this.persistTurn(user.id, "assistant", reply);
      return reply;
    }

    // Normal Hevn AI Secretary conversation loop
    const history = await this.getRecentHistory(user.id);
    const nowInUserTz = new Date().toLocaleString("sv-SE", { timeZone: user.timezone });

    // Fetch active follow-up context and structured memories if available
    let activeFollowUp = null;
    try {
      let candidates: Array<{ followUp: FollowUp; task: Task }> = [];
      if (typeof this.followUpService.getActiveCandidateFollowUps === "function") {
        candidates = await this.followUpService.getActiveCandidateFollowUps(user.id);
      }

      if (candidates.length === 1) {
        activeFollowUp = candidates[0];
      } else if (candidates.length > 1) {
        // Check if user specifically mentioned one of the candidate tasks by name
        const lowerText = text.toLowerCase();
        const matched = candidates.filter((c) => {
          const titleWords = c.task.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 2);
          return titleWords.some((w: string) => lowerText.includes(w));
        });

        if (matched.length === 1) {
          activeFollowUp = matched[0];
        } else if (isAmbiguousFollowUpResponse(text)) {
          // Multiple candidate follow-ups and ambiguous bare reply -> DO NOT GUESS!
          const options = candidates.map((c) => `"${c.task.title}"`).join(" or ");
          const reply = `You have ${candidates.length} open follow-ups. Which one did you mean — ${options}?`;
          await this.persistTurn(user.id, "user", text);
          await this.persistTurn(user.id, "assistant", reply);
          return reply;
        }
      } else if (candidates.length === 0 && typeof this.followUpService.getLatestPendingFollowUp === "function") {
        const activeFollowUpRecord = await this.followUpService.getLatestPendingFollowUp(user.id);
        if (activeFollowUpRecord) {
          const task = await this.taskService.getTask(user.id, activeFollowUpRecord.taskId);
          if (task) {
            activeFollowUp = { followUp: activeFollowUpRecord, task };
          }
        }
      }
    } catch (err) {
      logger.debug({ err, userId: user.id }, "Could not fetch pending follow-up context");
    }

    let memories: UserMemory[] = [];
    try {
      memories = await this.memoryService.getMemories(user.id, undefined, 10);
    } catch (err) {
      logger.debug({ err, userId: user.id }, "Could not fetch user memories");
    }

    const systemPrompt = buildSystemPrompt({
      botName: user.assistantName || user.botPersona || "Hevn",
      studentName: user.displayName,
      persona: user.persona,
      currentIsoDateTime: nowInUserTz,
      timezone: user.timezone,
      isOnboarded: true,
      activeFollowUp,
      memories,
    });

    const MAX_TOOL_ROUNDS = 3; // hard cap — prevents a runaway tool-calling loop from burning quota/cost
    let current = await this.gemma.converse(systemPrompt, history, text, taskTools);
    let fallback = "Got it.";

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (current.toolCalls.length === 0 || !current.rawContent) break;

      const toolResults: ToolResult[] = [];
      const summaries: string[] = [];
      for (const call of current.toolCalls) {
        const { summary, data } = await this.executeTool(user.id, user.timezone, call);
        toolResults.push({ name: call.name, response: data });
        summaries.push(summary);
      }
      fallback = summaries.join("\n");

      current = await this.gemma.continueWithToolResults(
        systemPrompt,
        history,
        text,
        current.rawContent,
        toolResults,
        taskTools
      );
    }

    const replyText = extractReply(current.text) ?? `Here's what I found:\n${fallback}`;

    await this.persistTurn(user.id, "user", text);
    await this.persistTurn(user.id, "assistant", replyText);

    return replyText;
  }

  /**
   * Executes a tool call for real. Returns both a human-readable summary
   * and structured data fed back to the model as ground truth.
   */
  private async executeTool(
    userId: string,
    userTimezone: string,
    call: ToolCall
  ): Promise<{ summary: string; data: Record<string, unknown> }> {
    try {
      switch (call.name) {
        case "create_task": {
          const task = await this.taskService.createTask(userId, {
            title: call.args.title,
            dueAtIso: call.args.due_at_iso,
            priority: call.args.priority,
            taskType: call.args.task_type ?? "task",
            parentTaskId: call.args.parent_task_id ?? null,
            projectId: call.args.project_id ?? null,
            reminderOffsetMinutes: call.args.reminder_offset_minutes ?? null,
          });
          return {
            summary: `Added "${task.title}" for ${new Date(task.dueAt).toLocaleString()}.`,
            data: { success: true, task },
          };
        }

        case "update_task": {
          const task = await this.taskService.updateTask(userId, String(call.args.task_id), {
            title: call.args.title as string | undefined,
            dueAtIso: call.args.due_at_iso as string | undefined,
            priority: call.args.priority as "low" | "medium" | "high" | undefined,
            reminderOffsetMinutes: call.args.reminder_offset_minutes as number | undefined,
            projectId: call.args.project_id as string | undefined,
          });
          return task
            ? { summary: `Updated "${task.title}".`, data: { success: true, task } }
            : { summary: "I couldn't find that task.", data: { success: false, error: "task_not_found" } };
        }

        case "mark_task_status": {
          const task = await this.taskService.markStatus(
            userId,
            String(call.args.task_id),
            call.args.status as "pending" | "in_progress" | "done"
          );
          return task
            ? { summary: `Marked "${task.title}" as ${task.status}.`, data: { success: true, task } }
            : { summary: "I couldn't find that task.", data: { success: false, error: "task_not_found" } };
        }

        case "snooze_task": {
          const task = await this.taskService.snoozeTask(
            userId,
            String(call.args.task_id),
            Number(call.args.snooze_minutes)
          );
          return task
            ? {
                summary: `Snoozed "${task.title}" — new time ${new Date(task.dueAt).toLocaleString()}.`,
                data: { success: true, task },
              }
            : { summary: "I couldn't find that task.", data: { success: false, error: "task_not_found" } };
        }

        case "get_upcoming_tasks": {
          const tasks = await this.taskService.getUpcomingTasks(userId, Number(call.args.limit ?? 10));
          return {
            summary:
              tasks.length === 0
                ? "You have nothing upcoming — clean slate!"
                : tasks.map((t) => `• ${t.title} [${t.taskType}] — ${new Date(t.dueAt).toLocaleString()}`).join("\n"),
            data: { tasks },
          };
        }

        case "get_weekly_report": {
          const report = await this.insightsService.getWeeklyReport(userId, userTimezone);
          return {
            summary: report.conversationalSummary || `Completed ${report.tasksCompleted} tasks this week.`,
            data: { report },
          };
        }

        case "create_task_breakdown": {
          const subtaskItems = Array.isArray(call.args.subtasks)
            ? (call.args.subtasks as Array<Record<string, unknown>>)
            : [];
          const tasks = await this.taskService.createTaskBreakdown(userId, {
            subtasks: subtaskItems.map((s) => ({
              title: s.title,
              dueAtIso: s.due_at_iso,
              priority: s.priority,
              reminderOffsetMinutes: s.reminder_offset_minutes,
            })),
          });
          return {
            summary: `Broke that into ${tasks.length} steps.`,
            data: { success: true, tasks },
          };
        }

        case "schedule_followup": {
          const followUp = await this.followUpService.scheduleFollowUp(
            userId,
            String(call.args.task_id),
            String(call.args.scheduled_at_iso)
          );
          return {
            summary: `Scheduled follow-up for ${new Date(followUp.scheduledAt).toLocaleString()}.`,
            data: { success: true, followUp },
          };
        }

        case "respond_followup": {
          const result = await this.followUpService.handleFollowUpResponse(
            userId,
            String(call.args.followup_id),
            call.args.intent as FollowUpIntent,
            call.args.new_scheduled_at_iso ? String(call.args.new_scheduled_at_iso) : undefined,
            call.args.snooze_minutes ? Number(call.args.snooze_minutes) : undefined
          );
          return {
            summary: result.message,
            data: result,
          };
        }

        case "create_recurring_task": {
          const recurring = await this.recurringService.createRecurringTask(userId, {
            title: call.args.title,
            recurrencePattern: call.args.recurrence_pattern as RecurrencePattern,
            daysOfWeek: Array.isArray(call.args.days_of_week) ? (call.args.days_of_week as number[]) : null,
            timeOfDay: String(call.args.time_of_day || "09:00"),
            timezone: userTimezone,
            priority: call.args.priority ?? "medium",
          });
          return {
            summary: `Created recurring task "${recurring.title}" (${recurring.recurrencePattern} at ${recurring.timeOfDay}). Next run: ${new Date(recurring.nextRunAt).toLocaleString()}.`,
            data: { success: true, recurring },
          };
        }

        case "list_recurring_tasks": {
          const recurring = await this.recurringService.listRecurringTasks(userId);
          return {
            summary:
              recurring.length === 0
                ? "No active recurring tasks."
                : recurring.map((r) => `• ${r.title} (${r.recurrencePattern} at ${r.timeOfDay})`).join("\n"),
            data: { recurring },
          };
        }

        case "cancel_recurring_task": {
          const success = await this.recurringService.cancelRecurringTask(userId, String(call.args.recurring_task_id));
          return {
            summary: success ? "Recurring task cancelled." : "Could not find recurring task.",
            data: { success },
          };
        }

        case "store_memory": {
          const memory = await this.memoryService.storeMemory(userId, {
            category: (call.args.category as MemoryCategory) || "general",
            content: String(call.args.content),
            key: call.args.key ? String(call.args.key) : null,
          });
          return {
            summary: `Remembered: "${memory.content}"`,
            data: { success: true, memory },
          };
        }

        case "forget_memory": {
          const success = await this.memoryService.forgetMemoryByKey(userId, String(call.args.key_or_content));
          return {
            summary: success ? "Updated memory." : "No matching memory found.",
            data: { success },
          };
        }

        case "query_memories": {
          const memories = await this.memoryService.searchMemories(userId, String(call.args.query || ""));
          return {
            summary:
              memories.length === 0
                ? "No memories found."
                : memories.map((m) => `• [${m.category}] ${m.content}`).join("\n"),
            data: { memories },
          };
        }

        case "create_project": {
          const project = await this.projectService.createProject(userId, {
            name: String(call.args.name),
            description: call.args.description ? String(call.args.description) : null,
          });
          return {
            summary: `Created project "${project.name}".`,
            data: { success: true, project },
          };
        }

        case "query_projects": {
          const projects = await this.projectService.getProjects(userId);
          return {
            summary:
              projects.length === 0
                ? "No projects found."
                : projects.map((p) => `• ${p.name}: ${p.description || "No description"}`).join("\n"),
            data: { projects },
          };
        }

        case "get_project_summary": {
          const summary = await this.projectService.getProjectSummary(
            userId,
            String(call.args.project_name_or_id)
          );
          if (!summary) {
            return {
              summary: "I couldn't find that project.",
              data: { success: false, error: "project_not_found" },
            };
          }
          const remainingLines = summary.remainingTasks.length > 0
            ? "\nRemaining:\n" + summary.remainingTasks.map((t) => `• ${t.title} (due ${new Date(t.dueAt).toLocaleDateString()})`).join("\n")
            : "\nAll tasks completed!";
          return {
            summary: `Project "${summary.project.name}": ${summary.completedTasks}/${summary.totalTasks} completed (${summary.completionPercentage}%). ${summary.pendingTasks} remaining.${remainingLines}`,
            data: { success: true, summary },
          };
        }

        case "complete_registration": {
          await this.userService.completeRegistration(
            userId,
            String(call.args.display_name),
            String(call.args.timezone),
            String(call.args.bot_persona)
          );
          return { summary: "Registration complete.", data: { success: true } };
        }

        case "set_checkin_time": {
          await this.userService.setCheckinHour(userId, Number(call.args.hour));
          return { summary: "Check-in time updated.", data: { success: true } };
        }

        case "set_quiet_hours": {
          await this.userService.setQuietHours(
            userId,
            String(call.args.start_time),
            String(call.args.end_time)
          );
          return {
            summary: `Quiet hours set from ${call.args.start_time} to ${call.args.end_time}.`,
            data: { success: true },
          };
        }

        default:
          return { summary: "I don't support that action yet.", data: { success: false, error: "unsupported_tool" } };
      }
    } catch (err) {
      logger.error({ err, tool: call.name, userId }, "Tool execution error");
      return { summary: "Something went wrong handling that.", data: { success: false, error: "internal_error" } };
    }
  }

  private async getRecentHistory(userId: string): Promise<ConversationTurn[]> {
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT role, content, created_at FROM conversation_turns
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [userId, MAX_HISTORY_TURNS]
      );
      return rows
        .reverse()
        .map((r) => ({
          role: r.role as "user" | "assistant",
          content: r.content as string,
          timestamp: (r.created_at as Date).toISOString(),
        }));
    });
  }

  private async persistTurn(userId: string, role: "user" | "assistant", content: string): Promise<void> {
    await withUserScope(userId, async (client) => {
      await client.query(
        `INSERT INTO conversation_turns (user_id, role, content) VALUES ($1, $2, $3)`,
        [userId, role, content.slice(0, 4000)]
      );

      // Prune old turns beyond cap
      await client.query(
        `DELETE FROM conversation_turns
         WHERE user_id = $1
           AND id NOT IN (
             SELECT id FROM conversation_turns
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50
           )`,
        [userId]
      );
    });
  }
}

function isAmbiguousFollowUpResponse(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const ambiguousPhrases = [
    "yes", "done", "finished", "finished it", "done with it", "i did it", "already did it",
    "not yet", "no", "later", "snooze", "tomorrow", "cancel", "cancel it", "forget it",
    "give me an hour", "move it", "reschedule", "snooze 30", "snooze 60"
  ];
  return ambiguousPhrases.includes(normalized) || normalized.length <= 15;
}
