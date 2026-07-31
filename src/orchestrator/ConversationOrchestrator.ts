import { GemmaClient, ToolCall, ToolResult, extractReply } from "../core/gemma/GemmaClient";
import { taskTools } from "../core/gemma/tools";
import { buildSystemPrompt } from "../core/persona/systemPrompt";
import { TaskService } from "../core/tasks/TaskService";
import { withUserScope } from "../db/pool";
import type { ConversationTurn, User } from "../types/domain";
import { InsightsService } from "../core/insights/InsightsService";
import { UserService } from "../core/tasks/UserService";

const MAX_HISTORY_TURNS = 12; // cap context; prevents unbounded token growth and cost

export class ConversationOrchestrator {
  constructor(
    private gemma: GemmaClient,
    private taskService: TaskService,
    private userService: UserService,
    private insightsService: InsightsService,
    // private botName: string
  ) {}

  /**
   * Main entry point: takes a user's raw message, returns the reply text
   * to send back. Handles tool-call execution and persists conversation
   * history + task changes.
   */
  async handleMessage(user: User, rawText: string): Promise<string> {
    try {
      return await this.handleMessageInner(user, rawText);
    } catch (err) {
      console.error("handleMessage failed, returning graceful fallback:", err);
      return "Sorry, I hit a snag on my end just now — mind trying that again?";
    }
  }

  private async handleMessageInner(user: User, rawText: string): Promise<string> {
    const text = rawText.trim().slice(0, 2000);
    if (text.length === 0) {
      return "I didn't catch that — could you send it again?";
    }

    const history = await this.getRecentHistory(user.id);
    const nowInUserTz = new Date().toLocaleString("sv-SE", { timeZone: user.timezone });
    const systemPrompt = buildSystemPrompt({
      botName: user.botPersona,
      studentName: user.displayName,
      currentIsoDateTime: nowInUserTz,
      timezone: user.timezone,
      isOnboarded: user.onboarded,
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
   * (used only as a last-resort fallback if the follow-up model call
   * fails) and structured data (fed back to the model as ground truth —
   * this is what lets it reference real task IDs on later turns instead
   * of inventing them).
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
                : tasks.map((t) => `• ${t.title} — ${new Date(t.dueAt).toLocaleString()}`).join("\n"),
            data: { tasks },
          };
        }
        case "get_weekly_report": {
          const report = await this.insightsService.getWeeklyReport(userId, userTimezone);
          return {
            summary: `Completed ${report.tasksCompleted}/${report.tasksCompleted + report.tasksMissed} this week.`,
            data: { report },
          };
        }
        case "create_task_breakdown": {
          const tasks = await this.taskService.createTaskBreakdown(userId, {
            subtasks: (call.args.subtasks as unknown[])?.map((s: any) => ({
              title: s.title,
              dueAtIso: s.due_at_iso,
              priority: s.priority,
            })),
          });
          return {
            summary: `Broke that into ${tasks.length} steps.`,
            data: { success: true, tasks },
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
        default:
          return { summary: "I don't support that action yet.", data: { success: false, error: "unsupported_tool" } };
      }
    } catch (err) {
      console.error("Tool execution error:", err);
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

      // Prune old turns beyond a generous cap so the table doesn't grow
      // unbounded (data minimization — see schema.sql comment). Runs on
      // the SAME scoped client/transaction as the insert above, so RLS
      // sees app.current_user_id set correctly for both statements.
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
