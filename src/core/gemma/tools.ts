import { Type } from "./GemmaClient";
import type { FunctionDeclaration } from "@google/genai";

/**
 * Tool schemas exposed to Gemma. Keep names/descriptions precise —
 * Gemma decides when to call these based on how clearly they're
 * described, not just their parameter shapes.
 *
 * SECURITY NOTE: these declarations only describe *what the model may
 * request*. The orchestrator (ConversationOrchestrator.ts) still
 * validates every argument server-side before touching the database —
 * a tool declaration is not a trust boundary.
 */
export const taskTools: FunctionDeclaration[] = [
  {
    name: "create_task",
    description:
      "Create a new task, commitment, meeting, assignment, exam, or event. Call this " +
      "as soon as you have a clear title and due date/time from the conversation, " +
      "even if reminder timing hasn't been decided yet.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Short, clear title of the task or commitment" },
        due_at_iso: {
          type: Type.STRING,
          description:
            "Due date and time in ISO 8601 format, resolved from the user's " +
            "message and the current date provided in context. If only a date " +
            "is given with no time, default to 23:59.",
        },
        priority: {
          type: Type.STRING,
          enum: ["low", "medium", "high"],
          description: "Infer from urgency/language if not stated explicitly.",
        },
        reminder_offset_minutes: {
          type: Type.NUMBER,
          description:
            "Minutes before due_at_iso to send a reminder. Ask the user if " +
            "unspecified, or omit this field to ask separately.",
        },
      },
      required: ["title", "due_at_iso", "priority"],
    },
  },
  {
    name: "update_task",
    description: "Update an existing task or commitment's title, due date, priority, or reminder timing.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.STRING, description: "ID of the task to update" },
        title: { type: Type.STRING },
        due_at_iso: { type: Type.STRING },
        priority: { type: Type.STRING, enum: ["low", "medium", "high"] },
        reminder_offset_minutes: { type: Type.NUMBER },
      },
      required: ["task_id"],
    },
  },
  {
    name: "mark_task_status",
    description: "Mark a task or commitment as done, in progress, or reset to pending.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.STRING },
        status: { type: Type.STRING, enum: ["pending", "in_progress", "done"] },
      },
      required: ["task_id", "status"],
    },
  },
  {
    name: "snooze_task",
    description: "Push a task or reminder back by a relative amount of time.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.STRING },
        snooze_minutes: {
          type: Type.NUMBER,
          description: "How many minutes to delay the reminder by.",
        },
      },
      required: ["task_id", "snooze_minutes"],
    },
  },
  {
    name: "get_upcoming_tasks",
    description:
      "Fetch the user's upcoming tasks and commitments. Use this whenever you need context to " +
      "answer questions like 'what do I have to do this week' or before updating/completing tasks.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        limit: { type: Type.NUMBER, description: "Max number of tasks to return, default 10" },
      },
      required: [],
    },
  },
  {
    name: "get_weekly_report",
    description:
      "Get the user's productivity summary for the past 7 days — completion rate, " +
      "missed tasks, best day, and suggestions. Call this when the user asks how " +
      "they're doing, for a weekly report, or similar progress questions.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "create_task_breakdown",
    description:
      "Break a larger goal (project, presentation, thesis, product launch, exam prep) into " +
      "several smaller tasks with staggered due dates, when the user describes something " +
      "spanning multiple weeks or clearly needing more than one step. Decide a sensible " +
      "breakdown yourself with due dates spread between now and the final deadline.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        subtasks: {
          type: Type.ARRAY,
          description: "Ordered list of subtasks making up the breakdown.",
          items: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              due_at_iso: { type: Type.STRING, description: "ISO 8601 due date/time for this subtask" },
              priority: { type: Type.STRING, enum: ["low", "medium", "high"] },
              reminder_offset_minutes: {
                type: Type.NUMBER,
                description: "Minutes before this subtask's due date to send a reminder. Omit to default to 60.",
              },
            },
            required: ["title", "due_at_iso", "priority"],
          },
        },
      },
      required: ["subtasks"],
    },
  },
  {
    name: "complete_registration",
    description:
      "Call this ONCE you have collected the user's name, IANA timezone, and chosen " +
      "assistant name during onboarding.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        display_name: { type: Type.STRING },
        timezone: { type: Type.STRING, description: "IANA timezone, e.g. Africa/Lagos, America/New_York" },
        bot_persona: {
          type: Type.STRING,
          enum: ["Mumin", "Khadijah", "Scott", "Claire"],
        },
        persona: {
          type: Type.STRING,
          enum: ["student", "executive_assistant", "professional"],
        },
      },
      required: ["display_name", "timezone", "bot_persona"],
    },
  },
  {
    name: "set_checkin_time",
    description:
      "Change what hour (0-23, in the user's local timezone) the daily morning " +
      "check-in is sent. Call when the user wants to adjust their check-in time.",
    parameters: {
      type: Type.OBJECT,
      properties: { hour: { type: Type.NUMBER } },
      required: ["hour"],
    },
  },
];
