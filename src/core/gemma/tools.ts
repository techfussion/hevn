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
    name: "set_user_identity",
    description:
      "Update user conversational identity preferences, preferred name, username, or nameless mode " +
      "(e.g. 'Call me Raj', 'My preferred name is Mumin', 'Set my username to raj', 'Don't use my name').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        preferred_name: {
          type: Type.STRING,
          description: "User's preferred conversational name/nickname (e.g. 'Raj', 'Mumin'). Pass empty string or null to reset.",
        },
        username: {
          type: Type.STRING,
          description: "User's chosen handle (alphanumeric, 3-30 chars, without @).",
        },
        nameless_mode: {
          type: Type.BOOLEAN,
          description: "Set to true if user explicitly asks not to be addressed by name in messages.",
        },
        full_name: {
          type: Type.STRING,
          description: "User's formal/full name for administrative context.",
        },
      },
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
  {
    name: "list_calendar_events",
    description:
      "Fetch upcoming external calendar events (e.g. 'What is on my calendar tomorrow?', 'Check my schedule for Thursday', 'Do I have meetings today?').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        time_min_iso: { type: Type.STRING, description: "ISO 8601 start of search window" },
        time_max_iso: { type: Type.STRING, description: "ISO 8601 end of search window" },
        limit: { type: Type.NUMBER, description: "Maximum events to return, default 10" },
      },
      required: ["time_min_iso", "time_max_iso"],
    },
  },
  {
    name: "check_calendar_availability",
    description:
      "Check whether the user is free or busy during a specific time range, or find free slots (e.g. 'Am I free Thursday afternoon?', 'Find a 1-hour free slot tomorrow morning').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        time_min_iso: { type: Type.STRING, description: "ISO 8601 start of time range to inspect" },
        time_max_iso: { type: Type.STRING, description: "ISO 8601 end of time range to inspect" },
        duration_minutes: { type: Type.NUMBER, description: "Desired continuous free slot duration in minutes (default 30)" },
      },
      required: ["time_min_iso", "time_max_iso"],
    },
  },
  {
    name: "create_calendar_event",
    description:
      "Explicitly schedule or create an event on the user's connected external calendar (e.g. 'Put my dentist appointment on my Google Calendar Friday at 10am').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, description: "Title of the calendar event" },
        start_at_iso: { type: Type.STRING, description: "ISO 8601 start datetime" },
        end_at_iso: { type: Type.STRING, description: "ISO 8601 end datetime" },
        description: { type: Type.STRING, description: "Optional description or notes" },
        calendar_id: { type: Type.STRING, description: "Optional target calendar ID" },
      },
      required: ["title", "start_at_iso", "end_at_iso"],
    },
  },
  {
    name: "connect_calendar_instructions",
    description:
      "Generate a secure connection link or instructions when user asks to connect Google Calendar or Apple iCal/CalDAV (e.g. 'Connect my Google Calendar', 'Link my iCal').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        provider: {
          type: Type.STRING,
          enum: ["google", "caldav"],
          description: "Calendar provider to connect",
        },
      },
      required: ["provider"],
    },
  },
  {
    name: "disconnect_calendar",
    description:
      "Disconnect an external calendar provider without deleting internal Hevn tasks (e.g. 'Disconnect my Google Calendar').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        provider: {
          type: Type.STRING,
          enum: ["google", "caldav"],
          description: "Calendar provider to disconnect",
        },
      },
      required: ["provider"],
    },
  },
  {
    name: "set_voice_preferences",
    description:
      "Configure user response mode and voice settings (e.g. 'Reply to me with voice', 'Switch to text only', 'Use voice messages').",
    parameters: {
      type: Type.OBJECT,
      properties: {
        response_mode: {
          type: Type.STRING,
          enum: ["text", "voice", "auto"],
          description: "Response mode: 'text' (always reply with text), 'voice' (always reply with voice), or 'auto' (reply with voice when user sends voice).",
        },
        voice_enabled: {
          type: Type.BOOLEAN,
          description: "Enable or disable voice output capability",
        },
        voice_name: {
          type: Type.STRING,
          description: "Optional voice identifier or voice style preset",
        },
      },
      required: [],
    },
  },
  {
    name: "create_course",
    description: "Create or register an academic course or subject for the student.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: "Name of the course (e.g. 'Database Systems', 'Linear Algebra')" },
        code: { type: Type.STRING, description: "Course code (e.g. 'CS301', 'MATH101')" },
        description: { type: Type.STRING, description: "Optional course description" },
        instructor: { type: Type.STRING, description: "Optional instructor/professor name" },
        semester: { type: Type.STRING, description: "Optional semester or term (e.g. 'Fall 2026')" },
      },
      required: ["name"],
    },
  },
  {
    name: "list_courses",
    description: "List the student's active or archived courses.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        status: {
          type: Type.STRING,
          enum: ["active", "completed", "archived"],
          description: "Filter by status (default: 'active')",
        },
      },
      required: [],
    },
  },
  {
    name: "create_course_topic",
    description: "Add a topic or module to a course.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        course_id: { type: Type.STRING, description: "ID of the course" },
        title: { type: Type.STRING, description: "Title of the topic (e.g. 'Normalization', 'Relational Algebra')" },
        description: { type: Type.STRING, description: "Optional topic overview" },
        estimated_study_minutes: { type: Type.NUMBER, description: "Estimated study minutes (default: 60)" },
      },
      required: ["course_id", "title"],
    },
  },
  {
    name: "list_course_topics",
    description: "List all topics and current mastery levels for a course.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        course_id: { type: Type.STRING, description: "ID of the course" },
      },
      required: ["course_id"],
    },
  },
  {
    name: "create_assessment",
    description: "Create an exam, midterm, final, quiz, or assignment for a course.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        course_id: { type: Type.STRING, description: "ID of the course" },
        title: { type: Type.STRING, description: "Title of the assessment (e.g. 'Database Midterm Exam')" },
        assessment_type: {
          type: Type.STRING,
          enum: ["exam", "midterm", "final", "quiz", "assignment", "project"],
          description: "Type of assessment",
        },
        due_at_iso: { type: Type.STRING, description: "Exam date/time in ISO 8601 format" },
        weight_percentage: { type: Type.NUMBER, description: "Optional percentage weight of course grade" },
      },
      required: ["course_id", "title", "due_at_iso"],
    },
  },
  {
    name: "list_assessments",
    description: "List upcoming exams, midterms, and assessments.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        course_id: { type: Type.STRING, description: "Optional course ID filter" },
      },
      required: [],
    },
  },
  {
    name: "create_study_plan",
    description:
      "Generate a structured, calendar-aware study plan with concrete sessions before an exam or deadline.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        course_id: { type: Type.STRING, description: "ID of the course" },
        assessment_id: { type: Type.STRING, description: "Optional assessment ID" },
        target_date_iso: { type: Type.STRING, description: "Exam/target date in ISO 8601 format" },
        session_duration_minutes: { type: Type.NUMBER, description: "Target session duration in minutes (default 60)" },
      },
      required: ["course_id", "target_date_iso"],
    },
  },
  {
    name: "get_study_plan",
    description: "Retrieve a study plan and its scheduled sessions.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        study_plan_id: { type: Type.STRING, description: "ID of the study plan" },
      },
      required: ["study_plan_id"],
    },
  },
  {
    name: "reschedule_study_session",
    description: "Move a study session to a new date/time.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        session_id: { type: Type.STRING, description: "ID of the study session" },
        new_start_iso: { type: Type.STRING, description: "New start time in ISO 8601 format" },
        duration_minutes: { type: Type.NUMBER, description: "Optional duration in minutes" },
      },
      required: ["session_id", "new_start_iso"],
    },
  },
  {
    name: "generate_quiz",
    description: "Generate an interactive quiz on a course topic.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic_title: { type: Type.STRING, description: "Topic to quiz on (e.g. 'Normalization', 'SQL')" },
        course_id: { type: Type.STRING, description: "Optional course ID" },
        topic_id: { type: Type.STRING, description: "Optional topic ID" },
        difficulty: { type: Type.STRING, enum: ["easy", "medium", "hard"], description: "Difficulty level" },
        question_count: { type: Type.NUMBER, description: "Number of questions (default: 5)" },
      },
      required: ["topic_title"],
    },
  },
  {
    name: "submit_quiz_answer",
    description: "Submit an answer to the current question in an active quiz.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        quiz_id: { type: Type.STRING, description: "ID of the active quiz" },
        user_answer: { type: Type.STRING, description: "User's submitted answer" },
      },
      required: ["quiz_id", "user_answer"],
    },
  },
  {
    name: "get_active_quiz",
    description: "Check if the user currently has an ongoing active quiz.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "generate_flashcards",
    description: "Generate a deck of study flashcards for quick revision.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        topic: { type: Type.STRING, description: "Topic for flashcards (e.g. 'Relational Algebra', '3NF')" },
        difficulty: { type: Type.STRING, enum: ["easy", "medium", "hard"] },
        card_count: { type: Type.NUMBER, description: "Number of cards (default: 5)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "get_study_recommendation",
    description: "Get personalized, adaptive study recommendations based on topic mastery and upcoming exams.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_study_insights",
    description: "Get study analytics: hours studied, session completion rate, quiz accuracy, strong and weak topics.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_secretary_briefing",
    description:
      "Synthesize a comprehensive, executive secretary briefing for today or a specific date, combining agenda timeline, external calendar events, tasks, commitments, study sessions, upcoming exams, projects, and schedule risk alerts.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        date_iso: {
          type: Type.STRING,
          description: "Optional ISO date (YYYY-MM-DD) for the briefing (defaults to today in user's timezone)",
        },
      },
      required: [],
    },
  },
];


