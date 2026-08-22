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
      "Create a new task, commitment, meeting, assignment, exam, or event. " +
      "Use task_type='commitment' for milestone events (e.g. 'I have an exam Thursday', 'board meeting on Friday'). " +
      "Use task_type='task' for concrete action items or preparation tasks.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Short, clear title of the task or commitment" },
        due_at_iso: {
          type: Type.STRING,
          description:
            "Due date and time in ISO 8601 format, resolved from the user's " +
            "message and current datetime in context. If only date is given, default to 23:59.",
        },
        priority: {
          type: Type.STRING,
          enum: ["low", "medium", "high"],
          description: "Infer from urgency/language if not stated explicitly.",
        },
        task_type: {
          type: Type.STRING,
          enum: ["task", "commitment", "reminder"],
          description: "Default is 'task'. Use 'commitment' for milestone events/exams/meetings.",
        },
        parent_task_id: {
          type: Type.STRING,
          description: "Optional ID of a parent commitment (for linked preparation tasks).",
        },
        project_id: {
          type: Type.STRING,
          description: "Optional project ID to associate this task with.",
        },
        reminder_offset_minutes: {
          type: Type.NUMBER,
          description: "Minutes before due_at_iso to send a reminder (e.g. 60, 1440).",
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
        project_id: { type: Type.STRING },
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
      "missed tasks, best day, and suggestions.",
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
      "several smaller tasks with staggered due dates.",
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
                description: "Minutes before this subtask's due date to send a reminder.",
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
    name: "schedule_followup",
    description:
      "Explicitly schedule a follow-up inquiry to ask if the user completed a task/commitment at a designated time.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task_id: { type: Type.STRING, description: "ID of the task to follow up on" },
        scheduled_at_iso: { type: Type.STRING, description: "ISO 8601 datetime to send the follow-up" },
      },
      required: ["task_id", "scheduled_at_iso"],
    },
  },
  {
    name: "respond_followup",
    description:
      "Resolve or update an active follow-up when user replies ('Done', 'Not yet', 'Remind me tomorrow', 'Cancel').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        followup_id: { type: Type.STRING, description: "ID of the follow-up being responded to" },
        intent: {
          type: Type.STRING,
          enum: ["completed", "not_yet", "reschedule", "snooze", "cancelled"],
          description: "The user's response intent",
        },
        new_scheduled_at_iso: {
          type: Type.STRING,
          description: "Required when intent='reschedule' — the new ISO 8601 datetime to check back.",
        },
        snooze_minutes: {
          type: Type.NUMBER,
          description: "Required when intent='snooze' — minutes to delay by.",
        },
      },
      required: ["followup_id", "intent"],
    },
  },
  {
    name: "create_recurring_task",
    description:
      "Create a generalized recurring task (e.g. 'Every Monday at 9am remind me to send the weekly report', 'Every weekday at 8am check priorities').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Title of the recurring task" },
        recurrence_pattern: {
          type: Type.STRING,
          enum: ["daily", "weekly", "weekdays", "custom"],
          description: "Recurrence pattern type",
        },
        days_of_week: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: "For weekly pattern: array of day numbers (0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat).",
        },
        time_of_day: {
          type: Type.STRING,
          description: "Time of day in HH:MM 24-hour format (e.g. '09:00', '17:30').",
        },
        priority: {
          type: Type.STRING,
          enum: ["low", "medium", "high"],
        },
      },
      required: ["title", "recurrence_pattern", "time_of_day"],
    },
  },
  {
    name: "list_recurring_tasks",
    description: "List all active recurring task schedules for the user.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "cancel_recurring_task",
    description: "Cancel an active recurring task schedule.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        recurring_task_id: { type: Type.STRING, description: "ID of the recurring task to cancel" },
      },
      required: ["recurring_task_id"],
    },
  },
  {
    name: "store_memory",
    description:
      "Persist structured persistent context, user facts, collaborators, or preferences (e.g. 'I work with Sarah on finance', 'My weekly report is due Fridays').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: {
          type: Type.STRING,
          enum: ["fact", "person", "project", "preference", "general"],
          description: "Category of the memory",
        },
        content: { type: Type.STRING, description: "Structured fact or context to remember" },
        key: { type: Type.STRING, description: "Optional short key (e.g. 'collaborator_sarah', 'weekly_report_day')" },
      },
      required: ["category", "content"],
    },
  },
  {
    name: "forget_memory",
    description: "Remove or correct a previously remembered fact or context by key or content matching.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        key_or_content: { type: Type.STRING, description: "Key or phrase to remove from memory (e.g. 'Sarah', 'weekly report')" },
      },
      required: ["key_or_content"],
    },
  },
  {
    name: "query_memories",
    description: "Look up structured memories and stored user context.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search query for memory lookup" },
      },
      required: [],
    },
  },
  {
    name: "create_project",
    description: "Create a lightweight project to group related tasks and commitments (e.g. 'Q3 Client Proposal', 'Final Year Thesis').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Project name" },
        description: { type: Type.STRING, description: "Optional short project description" },
      },
      required: ["name"],
    },
  },
  {
    name: "query_projects",
    description: "List the user's active projects.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_project_summary",
    description:
      "Get a complete status rollup for a project by name or ID (e.g. 'Show me everything in Q3 Proposal', 'How is the proposal going?', 'What's left for the proposal?'). Returns completion stats, remaining tasks, and upcoming commitments.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        project_name_or_id: {
          type: Type.STRING,
          description: "Project name (e.g. 'Q3 Proposal') or project UUID",
        },
      },
      required: ["project_name_or_id"],
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
      "check-in is sent.",
    parameters: {
      type: Type.OBJECT,
      properties: { hour: { type: Type.NUMBER } },
      required: ["hour"],
    },
  },
  {
    name: "set_quiet_hours",
    description: "Configure user's quiet hours (e.g. '22:00' to '07:00') during which proactive notifications are held until morning.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        start_time: { type: Type.STRING, description: "HH:MM format, e.g. '22:00'" },
        end_time: { type: Type.STRING, description: "HH:MM format, e.g. '07:00'" },
      },
      required: ["start_time", "end_time"],
    },
  },
];
