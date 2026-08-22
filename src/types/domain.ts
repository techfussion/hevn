/**
 * Core domain types. Kept separate from any platform (Telegram/WhatsApp)
 * or AI-provider (Gemma) concerns so business logic never depends on them.
 */

export type TaskPriority = "low" | "medium" | "high";
export type TaskStatus = "pending" | "in_progress" | "done" | "missed";
export type TaskType = "task" | "commitment" | "reminder" | "recurring_checkin";

export type OnboardingState =
  | "WELCOME"
  | "AWAITING_NAME"
  | "AWAITING_ASSISTANT_NAME"
  | "AWAITING_PERSONA"
  | "AWAITING_CHECKIN_TIME"
  | "COMPLETED";

export type UserPersona = "student" | "executive_assistant" | "professional";
export type AssistantName = "Mumin" | "Khadijah" | "Scott" | "Claire" | string;

export type FollowUpStatus =
  | "SCHEDULED"
  | "DUE"
  | "DELIVERED"
  | "WAITING_FOR_RESPONSE"
  | "COMPLETED"
  | "NOT_YET"
  | "RESCHEDULED"
  | "SNOOZED"
  | "CANCELLED";

export type FollowUpIntent = "completed" | "not_yet" | "reschedule" | "snooze" | "cancelled";
export type FollowUpPreference = "active" | "relaxed" | "off";

export type RecurrencePattern = "daily" | "weekly" | "weekdays" | "custom";
export type RecurringTaskStatus = "active" | "paused" | "cancelled";

export type MemoryCategory = "fact" | "person" | "project" | "preference" | "general";

export interface Task {
  id: string;
  userId: string;
  title: string;
  dueAt: string; // ISO 8601, always stored in UTC
  priority: TaskPriority;
  status: TaskStatus;
  taskType: TaskType;
  isSystemGenerated: boolean;
  parentTaskId?: string | null;
  projectId?: string | null;
  reminderOffsetMinutes: number | null; // null = no reminder requested
  reminderSentAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FollowUp {
  id: string;
  userId: string;
  taskId: string;
  scheduledAt: string;
  status: FollowUpStatus;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  deliveredAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringTask {
  id: string;
  userId: string;
  title: string;
  recurrencePattern: RecurrencePattern;
  daysOfWeek: number[] | null; // 0=Sun, 1=Mon, ..., 6=Sat
  timeOfDay: string; // "HH:MM" e.g. "09:00"
  timezone: string;
  priority: TaskPriority;
  status: RecurringTaskStatus;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserMemory {
  id: string;
  userId: string;
  category: MemoryCategory;
  content: string;
  key: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  platform: "telegram" | "whatsapp";
  platformUserId: string; // telegram chat id / whatsapp phone number
  displayName: string | null;
  timezone: string; // IANA tz, e.g. "Africa/Lagos" — captured at onboarding
  onboarded: boolean;
  onboardingState: OnboardingState;
  assistantName: string;
  botPersona: string; // alias for assistantName
  persona: UserPersona;
  preferredCheckinTime: string; // e.g. "06:00", "07:30"
  preferredCheckinHour: number; // 0..23
  plan: "free" | "pro";
  followupPreference: FollowUpPreference;
  quietHoursStart: string | null; // e.g. "22:00"
  quietHoursEnd: string | null; // e.g. "07:00"
  createdAt: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

/**
 * Outbound message the orchestrator wants sent back to the user.
 * Platform adapters translate this into their own send format.
 */
export interface OutboundMessage {
  userId: string;
  text: string;
}
