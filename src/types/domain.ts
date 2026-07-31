/**
 * Core domain types. Kept separate from any platform (Telegram/WhatsApp)
 * or AI-provider (Gemma) concerns so business logic never depends on them.
 */

export type TaskPriority = "low" | "medium" | "high";
export type TaskStatus = "pending" | "in_progress" | "done" | "missed";

export interface Task {
  id: string;
  userId: string;
  title: string;
  dueAt: string; // ISO 8601, always stored in UTC
  priority: TaskPriority;
  status: TaskStatus;
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
  botPersona: string;
  preferredCheckinHour: number;
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
