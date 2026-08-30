import test, { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ResponseCopyService } from "../src/core/notifications/ResponseCopyService";

describe("ResponseCopyService & Canonical Conversational Copy", () => {
  let copyService: ResponseCopyService;

  beforeEach(() => {
    copyService = new ResponseCopyService();
  });

  describe("Task Reminder Composition", () => {
    it("never begins message with 'Reminder:'", () => {
      const taskIds = [
        "task-123",
        "task-456",
        "task-789",
        "task-abc",
        "task-def",
        "550e8400-e29b-41d4-a716-446655440000",
      ];

      for (const id of taskIds) {
        const { text, voiceText } = copyService.composeTaskReminder(id, {
          taskTitle: "Submit quarterly taxes",
          dueTimeStr: "3:00 PM",
        });

        assert.equal(/^Reminder:/i.test(text), false, `Text begins with 'Reminder:': ${text}`);
        assert.equal(/^\[Reminder\]/i.test(text), false, `Text begins with '[Reminder]': ${text}`);
        assert.equal(/^Reminder:/i.test(voiceText), false, `Voice text begins with 'Reminder:': ${voiceText}`);
        assert.equal(text.includes("Submit quarterly taxes"), true);
      }
    });

    it("generates deterministic output for identical seeds", () => {
      const result1 = copyService.composeTaskReminder("task-123", {
        taskTitle: "Team sync",
        dueTimeStr: "10:00 AM",
      });

      const result2 = copyService.composeTaskReminder("task-123", {
        taskTitle: "Team sync",
        dueTimeStr: "10:00 AM",
      });

      assert.equal(result1.text, result2.text);
      assert.equal(result1.voiceText, result2.voiceText);
    });

    it("provides varied phrasing across different tasks", () => {
      const texts = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const { text } = copyService.composeTaskReminder(`task-uuid-${i}`, {
          taskTitle: "Review pull request",
          dueTimeStr: "2:00 PM",
        });
        texts.add(text);
      }

      assert.equal(texts.size > 1, true, "Should have generated multiple distinct variations");
    });
  });

  describe("Follow-Up Composition & History Awareness", () => {
    it("never begins message with 'Checking in:' or 'Just checking in:'", () => {
      const followUpIds = ["fu-1", "fu-2", "fu-3", "fu-4", "fu-5"];

      for (const id of followUpIds) {
        const { text, voiceText } = copyService.composeFollowUp(id, {
          taskTitle: "Send pitch deck",
          attemptCount: 1,
          wasSnoozed: false,
        });

        assert.equal(/^Checking in:/i.test(text), false);
        assert.equal(/^Just checking in:/i.test(text), false);
        assert.equal(/^Checking in:/i.test(voiceText), false);
      }
    });

    it("uses snooze-aware phrasing when task was previously snoozed", () => {
      const { text, voiceText } = copyService.composeFollowUp("fu-snoozed-1", {
        taskTitle: "Send pitch deck",
        attemptCount: 2,
        wasSnoozed: true,
      });

      const hasSnoozeContext =
        text.toLowerCase().includes("snooze") ||
        text.toLowerCase().includes("asked me") ||
        text.toLowerCase().includes("as requested");

      assert.equal(hasSnoozeContext, true);
      assert.equal(voiceText.includes("*"), false);
    });

    it("uses retry-aware phrasing when attempt count > 1 and not snoozed", () => {
      const { text } = copyService.composeFollowUp("fu-retry-1", {
        taskTitle: "Call accountant",
        attemptCount: 2,
        wasSnoozed: false,
      });

      const hasRetryContext =
        text.toLowerCase().includes("once more") ||
        text.toLowerCase().includes("again") ||
        text.toLowerCase().includes("earlier");

      assert.equal(hasRetryContext, true);
    });

    it("uses friendly conversational phrasing for initial follow-up", () => {
      const { text } = copyService.composeFollowUp("fu-initial-1", {
        taskTitle: "Sign contract",
        attemptCount: 1,
        wasSnoozed: false,
      });

      assert.equal(text.includes("Sign contract"), true);
    });
  });

  describe("Voice Output Sanitization", () => {
    it("strips emojis, asterisks, brackets, and markdown artifacts", () => {
      const markdownRaw = "📋 **Just checking in**: did you complete *Send Pitch Deck*? Reply `done` [here](https://app.hevn.ai) • ⏰";
      const sanitized = copyService.sanitizeForVoice(markdownRaw);

      assert.equal(sanitized.includes("📋"), false);
      assert.equal(sanitized.includes("⏰"), false);
      assert.equal(sanitized.includes("*"), false);
      assert.equal(sanitized.includes("`"), false);
      assert.equal(sanitized.includes("["), false);
      assert.equal(sanitized.includes("]"), false);
      assert.equal(sanitized.includes("https://"), false);
      assert.equal(sanitized.includes("here"), true);
      assert.equal(sanitized.includes("Send Pitch Deck"), true);
    });

    it("preserves readable punctuation and spoken clarity", () => {
      const { voiceText } = copyService.composeTaskReminder("task-123", {
        taskTitle: "Call Dr. Smith",
        dueTimeStr: "4:30 PM",
      });

      assert.equal(voiceText.includes("*"), false);
      assert.equal(voiceText.includes("Call Dr. Smith"), true);
      assert.equal(voiceText.includes("4:30 PM"), true);
    });
  });

  describe("Overdue Tasks, Study Sessions & Briefings", () => {
    it("composes proactive overdue task phrasing without blame", () => {
      const { text } = copyService.composeOverdueTask("task-overdue-1", {
        taskTitle: "Submit lab report",
      });

      assert.equal(text.includes("Submit lab report"), true);
      assert.equal(/deadline|reschedule|keep it open/i.test(text), true);
    });

    it("composes study session alert with course and topic context", () => {
      const { text } = copyService.composeStudySessionAlert("study-1", {
        courseName: "Operating Systems",
        topicName: "Virtual Memory",
        startsInMinutes: 15,
      });

      assert.equal(text.includes("Operating Systems"), true);
      assert.equal(text.includes("Virtual Memory"), true);
      assert.equal(text.includes("15 minutes"), true);
    });

    it("composes exam warning with remaining days and weak topics", () => {
      const { text } = copyService.composeExamWarning("exam-1", {
        courseName: "Algorithms",
        assessmentTitle: "Midterm Exam",
        daysRemaining: 3,
        weakTopics: ["Dynamic Programming", "Graph Traversal"],
      });

      assert.equal(text.includes("Algorithms Midterm Exam"), true);
      assert.equal(text.includes("in 3 days"), true);
      assert.equal(text.includes("Dynamic Programming"), true);
    });

    it("composes morning briefing with agenda lines", () => {
      const { text } = copyService.composeMorningBriefing(
        "user-1",
        {
          displayName: "Alex",
          tasksCount: 2,
        },
        ["• Math assignment — 10:00 AM", "• Gym — 5:00 PM"]
      );

      assert.equal(text.includes("Good morning Alex!"), true);
      assert.equal(text.includes("Math assignment — 10:00 AM"), true);
      assert.equal(text.includes("Gym — 5:00 PM"), true);
    });
  });

  describe("Humanized Error Formatting", () => {
    it("humanizes database and permission errors for end users", () => {
      const formatted = copyService.formatUserErrorMessage(
        "error: permission denied for table job_queue (code 42501)"
      );

      assert.equal(formatted.includes("42501"), false);
      assert.equal(formatted.includes("job_queue"), false);
      assert.equal(formatted.includes("permission denied"), false);
      assert.equal(formatted.includes("retry automatically in a moment"), true);
    });

    it("humanizes OAuth/Calendar disconnection errors", () => {
      const formatted = copyService.formatUserErrorMessage(
        "Google Calendar OAuth token expired / reauth required"
      );

      assert.equal(formatted.includes("Calendar access needs to be reconnected"), true);
      assert.equal(formatted.includes("/auth/google"), true);
    });
  });
});
