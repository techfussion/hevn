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
  CourseStatus,
  AssessmentType,
  QuizDifficulty,
} from "../types/domain";
import { InsightsService } from "../core/insights/InsightsService";
import { UserService } from "../core/tasks/UserService";
import { OnboardingService } from "../core/onboarding/OnboardingService";
import { FollowUpService } from "../core/followup/FollowUpService";
import { RecurringTaskService } from "../core/recurring/RecurringTaskService";
import { MemoryService } from "../core/memory/MemoryService";
import { ProjectService } from "../core/projects/ProjectService";
import { CalendarService } from "../core/calendar/CalendarService";
import { CourseService } from "../core/study/CourseService";
import { StudyPlanService } from "../core/study/StudyPlanService";
import { QuizService } from "../core/study/QuizService";
import { FlashcardService } from "../core/study/FlashcardService";
import { StudyRecommendationService } from "../core/study/StudyRecommendationService";
import { SyllabusIngestionService } from "../core/study/SyllabusIngestionService";
import { BriefingService } from "../core/briefing/BriefingService";
import { UserIdentityService } from "../core/users/UserIdentityService";
import { logger } from "../utils/logger";

const MAX_HISTORY_TURNS = 6; // cap context; prevents unbounded token growth and cost

export class ConversationOrchestrator {
  private onboardingService: OnboardingService;
  private followUpService: FollowUpService;
  private recurringService: RecurringTaskService;
  private memoryService: MemoryService;
  private projectService: ProjectService;
  private calendarService: CalendarService;
  private courseService: CourseService;
  private studyPlanService: StudyPlanService;
  private quizService: QuizService;
  private flashcardService: FlashcardService;
  private studyRecommendationService: StudyRecommendationService;
  private syllabusIngestionService: SyllabusIngestionService;
  private briefingService: BriefingService;

  constructor(
    private gemma: GemmaClient,
    private taskService: TaskService,
    private userService: UserService,
    private insightsService: InsightsService,
    followUpService?: FollowUpService,
    recurringService?: RecurringTaskService,
    memoryService?: MemoryService,
    projectService?: ProjectService,
    calendarService?: CalendarService,
    courseService?: CourseService,
    studyPlanService?: StudyPlanService,
    quizService?: QuizService,
    flashcardService?: FlashcardService,
    studyRecommendationService?: StudyRecommendationService,
    syllabusIngestionService?: SyllabusIngestionService,
    briefingService?: BriefingService
  ) {
    this.onboardingService = new OnboardingService(this.userService, this.taskService);
    this.followUpService = followUpService || new FollowUpService();
    this.recurringService = recurringService || new RecurringTaskService();
    this.memoryService = memoryService || new MemoryService();
    this.projectService = projectService || new ProjectService();
    this.calendarService = calendarService || new CalendarService();
    this.courseService = courseService || new CourseService(this.taskService);
    this.studyPlanService =
      studyPlanService || new StudyPlanService(this.courseService, this.taskService, this.calendarService);
    this.quizService = quizService || new QuizService(this.gemma, this.courseService);
    this.flashcardService = flashcardService || new FlashcardService(this.gemma);
    this.studyRecommendationService =
      studyRecommendationService || new StudyRecommendationService(this.courseService);
    this.syllabusIngestionService =
      syllabusIngestionService || new SyllabusIngestionService(this.gemma, this.courseService);
    this.briefingService =
      briefingService ||
      new BriefingService(
        this.taskService,
        this.followUpService,
        this.calendarService,
        this.courseService,
        this.insightsService
      );
  }

  getSyllabusIngestionService(): SyllabusIngestionService {
    return this.syllabusIngestionService;
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

    let activeQuiz = null;
    if (user.persona === "student" && this.quizService) {
      try {
        activeQuiz = await this.quizService.getActiveQuiz(user.id);
      } catch (err) {
        logger.debug({ err, userId: user.id }, "Could not fetch active quiz context");
      }
    }

    const systemPrompt = buildSystemPrompt({
      botName: user.assistantName || user.botPersona || "Hevn",
      studentName: UserIdentityService.resolveConversationalName(user),
      persona: user.persona,
      currentIsoDateTime: nowInUserTz,
      timezone: user.timezone,
      isOnboarded: true,
      activeFollowUp,
      memories,
      activeQuiz,
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

          // If this is a commitment, sync to connected external calendar if available
          if (task.taskType === "commitment") {
            this.calendarService.syncCommitmentToCalendar(userId, task).catch((err) => {
              logger.warn({ err, taskId: task.id }, "Background commitment calendar sync failed");
            });
          }

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

        case "set_user_identity": {
          const preferredName = call.args.preferred_name !== undefined ? String(call.args.preferred_name || "") : undefined;
          const rawUsername = call.args.username !== undefined ? String(call.args.username || "") : undefined;
          const namelessMode = call.args.nameless_mode !== undefined ? Boolean(call.args.nameless_mode) : undefined;
          const fullName = call.args.full_name !== undefined ? String(call.args.full_name || "") : undefined;

          let normalizedUsername: string | undefined = undefined;
          if (rawUsername) {
            const val = UserIdentityService.validateAndNormalizeUsername(rawUsername);
            if (!val.valid) {
              return { summary: `Invalid username: ${val.error}`, data: { success: false, error: val.error } };
            }
            normalizedUsername = val.normalized;
          }

          await this.userService.updateUserIdentity(userId, {
            preferredName: preferredName !== undefined ? (preferredName ? preferredName : null) : undefined,
            username: normalizedUsername !== undefined ? (normalizedUsername ? normalizedUsername : null) : undefined,
            namelessMode,
            fullName: fullName !== undefined ? (fullName ? fullName : null) : undefined,
          });

          let ack = "Got it! Identity preferences updated.";
          if (namelessMode) {
            ack = "Understood — I will not use your name in our messages.";
          } else if (preferredName) {
            ack = `Got it! I'll call you ${preferredName}.`;
          } else if (normalizedUsername) {
            ack = `Got it! Set your handle to @${normalizedUsername}.`;
          }

          return { summary: ack, data: { success: true } };
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

        case "list_calendar_events": {
          const events = await this.calendarService.listUpcomingEvents(
            userId,
            String(call.args.time_min_iso),
            String(call.args.time_max_iso),
            Number(call.args.limit || 10)
          );
          return {
            summary:
              events.length === 0
                ? "No calendar events found for that period."
                : events
                    .map(
                      (e) =>
                        `• ${e.title} (${new Date(e.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} - ${new Date(e.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})`
                    )
                    .join("\n"),
            data: { events },
          };
        }

        case "check_calendar_availability": {
          const availability = await this.calendarService.checkAvailability(
            userId,
            String(call.args.time_min_iso),
            String(call.args.time_max_iso),
            Number(call.args.duration_minutes || 30)
          );
          const summary = availability.isFree
            ? "You are completely free during that time!"
            : availability.freeSlots.length > 0
            ? `You have ${availability.freeSlots.length} available window(s). Free: ` +
              availability.freeSlots
                .map(
                  (s) =>
                    `${new Date(s.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${new Date(s.endAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                )
                .join(", ")
            : "You are busy during that entire period.";
          return {
            summary,
            data: { availability },
          };
        }

        case "create_calendar_event": {
          const event = await this.calendarService.createCalendarEvent(userId, {
            title: String(call.args.title),
            startAt: String(call.args.start_at_iso),
            endAt: String(call.args.end_at_iso),
            description: call.args.description ? String(call.args.description) : undefined,
            calendarId: call.args.calendar_id ? String(call.args.calendar_id) : undefined,
          });
          return {
            summary: `Scheduled "${event.title}" on your calendar for ${new Date(event.startAt).toLocaleString()}.`,
            data: { success: true, event },
          };
        }

        case "connect_calendar_instructions": {
          const provider = (call.args.provider as "google" | "caldav") || "google";
          try {
            const connectUrl = this.calendarService.generateConnectUrl(userId, provider);
            return {
              summary:
                provider === "google"
                  ? `Here is your secure link to connect Google Calendar: ${connectUrl}`
                  : `To connect your CalDAV calendar, please provide your server URL, username, and password.`,
              data: { success: true, connectUrl, provider },
            };
          } catch (err: unknown) {
            const errorMsg = err instanceof Error ? err.message : "Calendar connection unavailable.";
            return {
              summary: `Calendar connection is currently unavailable: ${errorMsg}. Please contact your administrator to configure Google OAuth credentials or use CalDAV.`,
              data: { success: false, error: errorMsg, provider },
            };
          }
        }

        case "disconnect_calendar": {
          const provider = (call.args.provider as "google" | "caldav") || "google";
          const disconnected = await this.calendarService.disconnectAccount(userId, provider);
          return {
            summary: disconnected
              ? `Disconnected your ${provider} calendar.`
              : `No active ${provider} calendar found to disconnect.`,
            data: { success: disconnected },
          };
        }

        case "set_voice_preferences": {
          const responseMode = call.args.response_mode as "text" | "voice" | "auto" | undefined;
          const voiceEnabled = typeof call.args.voice_enabled === "boolean" ? call.args.voice_enabled : undefined;
          const voiceName = typeof call.args.voice_name === "string" ? call.args.voice_name : undefined;

          await this.userService.setVoicePreferences(userId, {
            responseMode,
            voiceEnabled,
            voiceName,
          });

          let desc = "Updated your voice settings.";
          if (responseMode === "voice") {
            desc = "Got it! I will now reply to you with voice notes.";
          } else if (responseMode === "text") {
            desc = "Understood. I will stick to text replies.";
          } else if (responseMode === "auto") {
            desc = "Understood. I will automatically match your message format (voice for voice, text for text).";
          }

          return {
            summary: desc,
            data: { success: true, responseMode, voiceEnabled, voiceName },
          };
        }

        case "create_course": {
          const course = await this.courseService.createCourse(userId, {
            name: String(call.args.name),
            code: call.args.code as string | undefined,
            description: call.args.description as string | undefined,
            instructor: call.args.instructor as string | undefined,
            semester: call.args.semester as string | undefined,
          });
          return {
            summary: `Added course "${course.name}"${course.code ? ` (${course.code})` : ""}.`,
            data: { success: true, course },
          };
        }

        case "list_courses": {
          const courses = await this.courseService.listCourses(
            userId,
            call.args.status as CourseStatus | undefined
          );
          return {
            summary: `Found ${courses.length} course${courses.length === 1 ? "" : "s"}.`,
            data: { success: true, courses },
          };
        }

        case "create_course_topic": {
          const topic = await this.courseService.createTopic(userId, {
            courseId: String(call.args.course_id),
            title: String(call.args.title),
            description: call.args.description as string | undefined,
            estimatedStudyMinutes: call.args.estimated_study_minutes ? Number(call.args.estimated_study_minutes) : undefined,
          });
          return {
            summary: `Added topic "${topic.title}".`,
            data: { success: true, topic },
          };
        }

        case "list_course_topics": {
          const topics = await this.courseService.listTopics(userId, String(call.args.course_id));
          return {
            summary: `Found ${topics.length} topic${topics.length === 1 ? "" : "s"}.`,
            data: { success: true, topics },
          };
        }

        case "create_assessment": {
          const assessment = await this.courseService.createAssessment(userId, {
            courseId: String(call.args.course_id),
            title: String(call.args.title),
            assessmentType: (call.args.assessment_type as AssessmentType) || "exam",
            dueAt: String(call.args.due_at_iso),
            weightPercentage: call.args.weight_percentage ? Number(call.args.weight_percentage) : undefined,
          });
          return {
            summary: `Scheduled assessment "${assessment.title}" for ${new Date(assessment.dueAt).toLocaleString()}.`,
            data: { success: true, assessment },
          };
        }

        case "list_assessments": {
          const assessments = await this.courseService.listAssessments(
            userId,
            call.args.course_id ? String(call.args.course_id) : undefined
          );
          return {
            summary: `Found ${assessments.length} assessment${assessments.length === 1 ? "" : "s"}.`,
            data: { success: true, assessments },
          };
        }

        case "create_study_plan": {
          const result = await this.studyPlanService.generateStudyPlan(userId, {
            courseId: String(call.args.course_id),
            assessmentId: call.args.assessment_id ? String(call.args.assessment_id) : undefined,
            targetDate: String(call.args.target_date_iso),
            sessionDurationMinutes: call.args.session_duration_minutes ? Number(call.args.session_duration_minutes) : undefined,
            userTimezone,
          });
          return {
            summary: result.message || (result.success ? "Study plan created." : "Could not create study plan."),
            data: { ...result },
          };
        }

        case "get_study_plan": {
          const plan = await this.studyPlanService.getStudyPlan(userId, String(call.args.study_plan_id));
          const sessions = plan ? await this.studyPlanService.listStudySessions(userId, plan.id) : [];
          return plan
            ? { summary: `Study Plan: ${plan.title} (${sessions.length} sessions).`, data: { success: true, plan, sessions } }
            : { summary: "Study plan not found.", data: { success: false, error: "plan_not_found" } };
        }

        case "reschedule_study_session": {
          const session = await this.studyPlanService.rescheduleStudySession(
            userId,
            String(call.args.session_id),
            String(call.args.new_start_iso),
            call.args.duration_minutes ? Number(call.args.duration_minutes) : undefined
          );
          return session
            ? { summary: `Rescheduled study session to ${new Date(session.scheduledStart).toLocaleString()}.`, data: { success: true, session } }
            : { summary: "Could not find study session.", data: { success: false, error: "session_not_found" } };
        }

        case "generate_quiz": {
          const quiz = await this.quizService.generateQuiz(userId, {
            topicTitle: String(call.args.topic_title),
            courseId: call.args.course_id ? String(call.args.course_id) : undefined,
            topicId: call.args.topic_id ? String(call.args.topic_id) : undefined,
            difficulty: call.args.difficulty as QuizDifficulty | undefined,
            questionCount: call.args.question_count ? Number(call.args.question_count) : undefined,
          });
          const firstQ = quiz.questions[0];
          return {
            summary: `Generated quiz on ${quiz.title}. Question 1/${quiz.totalQuestions}: ${firstQ?.question || ""}`,
            data: { success: true, quiz, currentQuestion: firstQ },
          };
        }

        case "submit_quiz_answer": {
          const result = await this.quizService.submitAnswer(
            userId,
            String(call.args.quiz_id),
            String(call.args.user_answer)
          );
          const feedback = result.lastAnswerFeedback?.isCorrect
            ? `Correct! ${result.lastAnswerFeedback.explanation}`
            : `Not quite. The correct answer was "${result.lastAnswerFeedback?.expectedAnswer}". ${result.lastAnswerFeedback?.explanation || ""}`;

          return {
            summary: result.isFinished
              ? `Quiz complete! Score: ${result.finalScore?.score}/${result.finalScore?.total} (${result.finalScore?.percentage}%). ${result.finalScore?.recommendation || ""}`
              : `${feedback} Next Question (${result.questionIndex + 1}/${result.totalQuestions}): ${result.currentQuestion?.question || ""}`,
            data: { success: true, ...result },
          };
        }

        case "get_active_quiz": {
          const activeQuiz = await this.quizService.getActiveQuiz(userId);
          return activeQuiz
            ? {
                summary: `Active quiz: ${activeQuiz.title} (Question ${activeQuiz.currentQuestionIndex + 1} of ${activeQuiz.totalQuestions}).`,
                data: { success: true, activeQuiz },
              }
            : { summary: "No active quiz in progress.", data: { success: false, activeQuiz: null } };
        }

        case "generate_flashcards": {
          const cards = await this.flashcardService.generateFlashcards({
            topic: String(call.args.topic),
            difficulty: call.args.difficulty as QuizDifficulty | undefined,
            cardCount: call.args.card_count ? Number(call.args.card_count) : undefined,
          });
          return {
            summary: `Generated ${cards.length} flashcards for ${call.args.topic}.`,
            data: { success: true, flashcards: cards },
          };
        }

        case "get_study_recommendation": {
          const recommendations = await this.studyRecommendationService.getStudyRecommendations(userId);
          return {
            summary: recommendations.length > 0
              ? `Found ${recommendations.length} recommended topic${recommendations.length === 1 ? "" : "s"} to review.`
              : "All topics are currently on track!",
            data: { success: true, recommendations },
          };
        }

        case "get_study_insights": {
          const insights = await this.insightsService.getStudyInsights(userId, userTimezone);
          return {
            summary: `Completed ${insights.completedSessions} of ${insights.scheduledSessions} study sessions (${insights.totalStudyMinutes} total minutes).`,
            data: { success: true, insights },
          };
        }

        case "get_secretary_briefing": {
          const targetDateIso = call.args.date_iso ? String(call.args.date_iso) : undefined;
          const briefing = await this.briefingService.getDailyBriefing(userId, targetDateIso, userTimezone);
          return {
            summary: briefing.conversationalSummary,
            data: { success: true, briefing },
          };
        }

        default:
          return { summary: "I don't support that action yet.", data: { success: false, error: "unsupported_tool" } };
      }
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === "ReauthRequiredError" || "provider" in err)) {
        const connectUrl = this.calendarService.generateConnectUrl(userId, "google");
        return {
          summary: `Your Google Calendar connection has expired or was revoked. Please reconnect your calendar here: ${connectUrl}`,
          data: { success: false, reauthRequired: true, connectUrl },
        };
      }
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
