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

export interface Task {
  id: string;
  userId: string;
  title: string;
  dueAt: string; // ISO 8601, always stored in UTC
  priority: TaskPriority;
  status: TaskStatus;
  taskType: TaskType;
  isSystemGenerated: boolean;
  reminderOffsetMinutes: number | null; // null = no reminder requested
  reminderSentAt: string | null;
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

