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

export interface ProjectSummary {
  project: Project;
  totalTasks: number;
  completedTasks: number;
  pendingTasks: number;
  overdueTasks: number;
  upcomingTasks: number;
  commitmentsCount: number;
  completionPercentage: number;
  remainingTasks: Array<{
    id: string;
    title: string;
    dueAt: string;
    priority: TaskPriority;
    taskType: TaskType;
    isPreparation: boolean;
  }>;
  completedTasksList: Array<{
    id: string;
    title: string;
    dueAt: string;
  }>;
}

export type ResponseMode = "text" | "voice" | "auto";

export interface UserVoicePreferences {
  responseMode: ResponseMode;
  voiceEnabled: boolean;
  voiceName: string | null;
  voiceLanguage: string | null;
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
  responseMode: ResponseMode;
  voiceEnabled: boolean;
  voiceName: string | null;
  voiceLanguage: string | null;
  createdAt: string;
}

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface ActionButton {
  label: string;
  action: string;
}

/**
 * Outbound message the orchestrator wants sent back to the user.
 * Platform adapters translate this into their own send format.
 */
export interface OutboundMessage {
  userId: string;
  text: string;
  buttons?: ActionButton[];
}

export type CourseStatus = "active" | "completed" | "archived";

export interface Course {
  id: string;
  userId: string;
  name: string;
  code: string | null;
  description: string | null;
  instructor: string | null;
  institution: string | null;
  semester: string | null;
  status: CourseStatus;
  createdAt: string;
  updatedAt: string;
}

export type TopicStatus = "not_started" | "in_progress" | "mastered";

export interface CourseTopic {
  id: string;
  courseId: string;
  userId: string;
  title: string;
  description: string | null;
  ordering: number;
  estimatedStudyMinutes: number;
  masteryLevel: number; // 0 to 100
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
}

export type AssessmentType = "exam" | "midterm" | "final" | "quiz" | "assignment" | "project";

export interface Assessment {
  id: string;
  courseId: string;
  userId: string;
  title: string;
  assessmentType: AssessmentType;
  dueAt: string;
  weightPercentage: number | null;
  linkedTaskId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type StudyPlanStatus = "active" | "completed" | "archived";

export interface StudyPlan {
  id: string;
  userId: string;
  courseId: string;
  assessmentId: string | null;
  title: string;
  targetDate: string;
  status: StudyPlanStatus;
  totalPlannedMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export type StudySessionStatus = "scheduled" | "completed" | "skipped" | "rescheduled";

export interface StudySession {
  id: string;
  userId: string;
  studyPlanId: string;
  courseId: string;
  topicId: string | null;
  taskId: string | null;
  title: string;
  scheduledStart: string;
  scheduledEnd: string;
  plannedMinutes: number;
  actualMinutes: number | null;
  status: StudySessionStatus;
  createdAt: string;
  updatedAt: string;
}

export type QuizDifficulty = "easy" | "medium" | "hard";
export type QuizStatus = "CREATED" | "ACTIVE" | "ANSWERING" | "COMPLETED" | "REVIEWED";

export interface QuizQuestion {
  question: string;
  options?: string[];
  answer: string;
  explanation: string;
  topic?: string;
  type?: "multiple_choice" | "true_false" | "short_answer";
}

export interface QuizAnswer {
  questionIndex: number;
  userAnswer: string;
  isCorrect: boolean;
  feedback: string;
}

export interface Quiz {
  id: string;
  userId: string;
  courseId: string | null;
  topicId: string | null;
  title: string;
  difficulty: QuizDifficulty;
  questions: QuizQuestion[];
  status: QuizStatus;
  currentQuestionIndex: number;
  score: number;
  totalQuestions: number;
  answers: QuizAnswer[];
  createdAt: string;
  updatedAt: string;
}

export interface Flashcard {
  front: string;
  back: string;
  topic: string;
  difficulty?: QuizDifficulty;
}

export interface StudyRecommendation {
  topicId: string;
  topicTitle: string;
  courseName: string;
  currentMastery: number;
  reason: string;
  recommendedMinutes: number;
}

export interface StudyInsights {
  totalStudyMinutes: number;
  completedSessions: number;
  scheduledSessions: number;
  studyAdherenceRate: number | null;
  averageQuizAccuracy: number | null;
  strongestTopics: Array<{ topicTitle: string; masteryLevel: number }>;
  weakestTopics: Array<{ topicTitle: string; masteryLevel: number }>;
  upcomingAssessments: Array<{ title: string; courseName: string; dueAt: string }>;
}

// ============================================================
// P2.5: Durable Job Queue & Scheduling Types
// ============================================================

export type JobStatus = "pending" | "active" | "completed" | "failed" | "cancelled";

export interface Job<T = Record<string, unknown>> {
  id: string;
  queueName: string;
  jobType: string;
  userId: string | null;
  payload: T;
  status: JobStatus;
  idempotencyKey: string | null;
  singletonKey: string | null;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedUntil: string | null;
  lockedBy: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobOptions {
  queueName?: string;
  priority?: number;
  runAt?: string | Date;
  delaySeconds?: number;
  idempotencyKey?: string;
  singletonKey?: string;
  maxAttempts?: number;
}

// ============================================================
// P2.5: Notification Policy, Deduplication & Digest Types
// ============================================================

export type NotificationDedupStatus = "pending" | "delivered" | "suppressed" | "batched" | "deferred";

export interface NotificationDedupRecord {
  id: string;
  userId: string;
  dedupKey: string;
  channel: string;
  category: string;
  status: NotificationDedupStatus;
  payloadSummary: string | null;
  deliveredAt: string;
  createdAt: string;
}

export type NotificationAction = "deliver" | "defer" | "suppress" | "digest";

export interface NotificationDecision {
  eligible: boolean;
  action: NotificationAction;
  reason: string;
  deferredUntil?: string;
  deliveryModality: "text" | "voice";
  consolidatedPayload?: {
    text: string;
    buttons?: Array<{ label: string; action: string }>;
  };
}

export interface NotificationDigestItem {
  id: string;
  type: "reminder" | "follow_up" | "study_session" | "recurring_task";
  title: string;
  dueAt?: string;
}

export interface NotificationDigest {
  userId: string;
  channel: string;
  items: NotificationDigestItem[];
  formattedText: string;
}

// ============================================================
// P2.5: Schedule Risk Engine & Cross-Domain Secretary Briefing
// ============================================================

export type RiskSeverity = "low" | "medium" | "high" | "critical";

export type RiskCategory =
  | "schedule_conflict"
  | "overdue_commitment"
  | "exam_mastery_deficit"
  | "overloaded_day"
  | "quiet_hours_breach";

export interface RiskItem {
  id: string;
  category: RiskCategory;
  severity: RiskSeverity;
  title: string;
  description: string;
  suggestedAction?: string;
  metadata?: Record<string, unknown>;
}

export interface RiskAssessment {
  overallScore: RiskSeverity;
  totalRisks: number;
  risks: RiskItem[];
  mitigationSuggestions: string[];
}

export interface AgendaTimelineItem {
  time: string;
  endTime?: string;
  title: string;
  type: "calendar_event" | "study_session" | "task_deadline";
  sourceId?: string;
  metadata?: Record<string, unknown>;
}

export interface SecretaryBriefing {
  date: string;
  timezone: string;
  agenda: AgendaTimelineItem[];
  commitmentsDue: Task[];
  tasksDue: Task[];
  overdueTasks: Task[];
  pendingFollowUps: Array<{
    id: string;
    taskTitle: string;
    scheduledAt: string;
    attemptCount: number;
  }>;
  studySessions: StudySession[];
  upcomingAssessments: Assessment[];
  activeProjects: Array<{
    id: string;
    name: string;
    openTaskCount: number;
  }>;
  riskAssessment: RiskAssessment;
  weeklyMomentum: {
    completionRate: number | null;
    followThroughRate: number | null;
    summary: string;
  };
  conversationalSummary: string;
}

export type {
  CalendarProviderType,
  CalendarAccountStatus,
  CalendarAccessRole,
  CalendarSyncStatus,
  CalendarAccount,
  ConnectedCalendar,
  CalendarEvent,
  CalendarEventLink,
  TimeSlot,
  CalendarAvailability,
  AvailabilityOptions,
  FindSlotsPreferences,
  CalendarMetricEvent,
  DiscoveredCalendar,
  CalendarProvider,
} from "../core/calendar/types";
export { ReauthRequiredError } from "../core/calendar/types";


