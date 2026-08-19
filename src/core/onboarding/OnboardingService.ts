import { UserService } from "../tasks/UserService";
import { TaskService } from "../tasks/TaskService";
import { ASSISTANT_NAMES, USER_PERSONAS, type AssistantNameOption } from "../persona/personaNames";
import type { User, UserPersona } from "../../types/domain";
import { logger } from "../../utils/logger";

export class OnboardingService {
  constructor(
    private userService: UserService,
    private taskService?: TaskService
  ) {}

  /**
   * Main entry point for conversational onboarding state machine.
   * Deterministic, resumable, and validated against allowed options.
   */
  async handleOnboardingMessage(user: User, rawText: string): Promise<string> {
    const text = rawText.trim();
    const state = user.onboardingState ?? (user.onboarded ? "COMPLETED" : "WELCOME");

    switch (state) {
      case "WELCOME":
      case "AWAITING_NAME": {
        if (state === "WELCOME" && text.length === 0) {
          return (
            "Hey 👋 Welcome to Hevn. I'm your AI Secretary, here to help you keep track of what matters and actually get things done.\n\n" +
            "First, what should I call you?"
          );
        }

        // If user just initiated first contact with "Hi" or similar greeting
        if (state === "WELCOME" && isInitialGreeting(text)) {
          await this.userService.setOnboardingState(user.id, "AWAITING_NAME");
          return (
            "Hey 👋 Welcome to Hevn. I'm your AI Secretary, here to help you keep track of what matters and actually get things done.\n\n" +
            "First, what should I call you?"
          );
        }

        // Extract and clean name
        const name = extractName(text);
        if (!name || name.length < 2) {
          return "I didn't quite catch that — what name would you like me to call you?";
        }

        await this.userService.setDisplayName(user.id, name);
        await this.userService.setOnboardingState(user.id, "AWAITING_ASSISTANT_NAME");

        return (
          `Nice to meet you, ${name}.\n\n` +
          `Before we continue, I need a name too. You can call me:\n` +
          `• Mumin\n` +
          `• Khadijah\n` +
          `• Scott\n` +
          `• Claire\n\n` +
          `Pick whichever feels right.`
        );
      }

      case "AWAITING_ASSISTANT_NAME": {
        const matchedAssistant = matchAssistantName(text);
        if (!matchedAssistant) {
          return (
            `Please pick one of these names for me:\n` +
            `• Mumin\n` +
            `• Khadijah\n` +
            `• Scott\n` +
            `• Claire\n\n` +
            `Which one would you like?`
          );
        }

        await this.userService.setAssistantName(user.id, matchedAssistant);
        await this.userService.setOnboardingState(user.id, "AWAITING_PERSONA");

        return (
          `Got it. ${matchedAssistant} it is.\n\n` +
          `Now, I need to understand what you're usually trying to get done. Which one sounds most like you?\n` +
          `🎓 Student\n` +
          `📋 Executive Assistant\n` +
          `💼 Professional\n\n` +
          `Not sure which one fits? I can explain them first.`
        );
      }

      case "AWAITING_PERSONA": {
        if (isExplanationRequest(text)) {
          return (
            `Sure!\n\n` +
            `• 🎓 **Student**: I'll help you stay on top of assignments, exams, projects, and study plans.\n` +
            `• 📋 **Executive Assistant**: I'll help you manage meetings, follow-ups, documents, deadlines, and the workflow around the person or team you support.\n` +
            `• 💼 **Professional**: I'll help you manage work, projects, clients, deadlines, and day-to-day commitments.\n\n` +
            `Which one sounds most like you?`
          );
        }

        const matchedPersona = matchPersona(text);
        if (!matchedPersona) {
          return (
            `Which category best fits you?\n` +
            `1. 🎓 Student\n` +
            `2. 📋 Executive Assistant\n` +
            `3. 💼 Professional\n\n` +
            `(Or say "explain" to learn more about each one)`
          );
        }

        await this.userService.setPersona(user.id, matchedPersona);
        await this.userService.setOnboardingState(user.id, "AWAITING_CHECKIN_TIME");

        return (
          `Perfect. I'll tailor how I help you around your commitments.\n\n` +
          `One more thing.\n` +
          `Every day, I'll check in with you and ask what you need to get done. By default, I'll check in at 6:00 AM.\n\n` +
          `Would you like to keep that time, or would you prefer another time?`
        );
      }

      case "AWAITING_CHECKIN_TIME": {
        const parsedTime = parseCheckinTime(text);
        if (!parsedTime) {
          return (
            `I couldn't quite parse that time. You can say something like:\n` +
            `• "6am is fine"\n` +
            `• "8:00 AM"\n` +
            `• "7:30"\n` +
            `• "Make it 9am"\n\n` +
            `What time would you prefer for your daily morning check-in?`
          );
        }

        await this.userService.setCheckinTime(user.id, parsedTime.timeStr, parsedTime.hour);
        await this.userService.setOnboardingState(user.id, "COMPLETED");

        // Ensure the system-generated recurring Daily Check-in task is created for the free plan
        if (this.taskService) {
          try {
            await this.taskService.ensureDailyCheckinTask(user.id, parsedTime.timeStr);
          } catch (err) {
            logger.warn({ err, userId: user.id }, "Could not ensure daily checkin task during onboarding");
          }
        }

        const assistantDisplayName = user.assistantName || user.botPersona || "Hevn";
        logger.info({ userId: user.id, assistant: assistantDisplayName, persona: user.persona }, "Onboarding completed");

        return (
          `Perfect. You're all set.\n\n` +
          `I'll check in with you every day at ${parsedTime.displayTime} and help you keep track of what matters.\n` +
          `Whenever something comes up, just tell me. No forms. No complicated setup. Just talk to me.\n\n` +
          `So, what's on your mind?`
        );
      }

      case "COMPLETED":
      default:
        return "You're already set up! What can I help you organize today?";
    }
  }
}

/**
 * Checks if input is just an opening greeting without a name
 */
function isInitialGreeting(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  const greetings = ["hi", "hello", "hey", "start", "/start", "help", "hevn", "good morning", "good evening", "good day", "yo"];
  return greetings.includes(normalized);
}

/**
 * Extracts clean user name from natural language response
 */
export function extractName(text: string): string | null {
  const cleaned = text.trim();
  if (!cleaned) return null;

  // Patterns like "My name is Abdulhameed", "I am Raj", "Call me Sarah", "It's Alex"
  const patterns = [
    /^(?:my name is|i am|i'm|call me|it is|it's|this is)\s+([a-zA-Z\s'-]+)/i,
    /^([a-zA-Z\s'-]+)$/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (match && match[1]) {
      const candidate = match[1].trim();
      if (candidate.length >= 2 && candidate.length <= 100) {
        return candidate.charAt(0).toUpperCase() + candidate.slice(1);
      }
    }
  }

  return cleaned.slice(0, 100);
}

/**
 * Matches assistant name choice against allowed options
 */
export function matchAssistantName(text: string): AssistantNameOption | null {
  const lower = text.trim().toLowerCase();

  if (lower.includes("mumin") || lower === "1" || lower === "first" || lower === "the first one") {
    return "Mumin";
  }
  if (lower.includes("khadijah") || lower.includes("khadija") || lower === "2" || lower === "second") {
    return "Khadijah";
  }
  if (lower.includes("scott") || lower === "3" || lower === "third") {
    return "Scott";
  }
  if (lower.includes("claire") || lower.includes("clair") || lower === "4" || lower === "fourth" || lower === "the fourth one") {
    return "Claire";
  }

  for (const name of ASSISTANT_NAMES) {
    if (lower.includes(name.toLowerCase())) {
      return name;
    }
  }

  return null;
}

/**
 * Checks if user is asking for persona explanation
 */
function isExplanationRequest(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("explain") ||
    lower.includes("not sure") ||
    lower.includes("what does") ||
    lower.includes("what do they mean") ||
    lower.includes("difference") ||
    lower.includes("help me choose") ||
    lower.includes("tell me more")
  );
}

/**
 * Matches user persona against the 3 canonical roles
 */
export function matchPersona(text: string): UserPersona | null {
  const lower = text.trim().toLowerCase();

  if (lower.includes("student") || lower === "1" || lower.includes("academic") || lower.includes("university")) {
    return "student";
  }
  if (
    lower.includes("executive assistant") ||
    lower.includes("executive") ||
    lower.includes("ea") ||
    lower === "2" ||
    lower.includes("secretary")
  ) {
    return "executive_assistant";
  }
  if (
    lower.includes("professional") ||
    lower === "3" ||
    lower.includes("work") ||
    lower.includes("developer") ||
    lower.includes("designer") ||
    lower.includes("freelancer") ||
    lower.includes("consultant")
  ) {
    return "professional";
  }

  for (const persona of USER_PERSONAS) {
    if (lower.includes(persona.replace("_", " "))) {
      return persona;
    }
  }

  return null;
}

export interface ParsedCheckinTime {
  hour: number;
  minute: number;
  timeStr: string; // "HH:MM"
  displayTime: string; // "6:00 AM", "7:30 AM"
}

/**
 * Robust natural language check-in time parser
 */
export function parseCheckinTime(text: string): ParsedCheckinTime | null {
  const lower = text.trim().toLowerCase();

  // Acceptance of default 6:00 AM
  if (
    lower.includes("6am is fine") ||
    lower.includes("keep 6") ||
    lower === "6am" ||
    lower === "6:00" ||
    lower === "6:00 am" ||
    lower === "default" ||
    lower === "keep that" ||
    lower === "keep it" ||
    lower === "sure" ||
    lower === "yes" ||
    lower === "fine" ||
    lower === "okay" ||
    lower === "ok" ||
    lower === "sounds good" ||
    lower === "6"
  ) {
    return { hour: 6, minute: 0, timeStr: "06:00", displayTime: "6:00 AM" };
  }

  // Regex patterns for various time formats
  // Examples: "8am", "8:30am", "8:30 pm", "at 7", "7:30", "10 in the morning", "make it 8am"
  const timeRegex = /(?:at\s+|make it\s+|around\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|in the morning|in the evening)?/i;
  const match = lower.match(timeRegex);

  if (match && match[1]) {
    let hour = parseInt(match[1], 10);
    const minute = match[2] ? parseInt(match[2], 10) : 0;
    const meridian = match[3]?.toLowerCase();

    if (isNaN(hour) || isNaN(minute) || minute < 0 || minute > 59) {
      return null;
    }

    if (meridian) {
      if ((meridian === "pm" || meridian.includes("evening")) && hour < 12) {
        hour += 12;
      } else if ((meridian === "am" || meridian.includes("morning")) && hour === 12) {
        hour = 0;
      }
    } else {
      // Default to morning hours if unspecified for check-ins (e.g. 7 -> 7 AM)
      if (hour >= 1 && hour <= 11) {
        // Morning
      } else if (hour > 23) {
        return null;
      }
    }

    if (hour < 0 || hour > 23) return null;

    const formattedHour = String(hour).padStart(2, "0");
    const formattedMinute = String(minute).padStart(2, "0");
    const timeStr = `${formattedHour}:${formattedMinute}`;

    const displayPeriod = hour >= 12 ? "PM" : "AM";
    const displayHour = hour % 12 === 0 ? 12 : hour % 12;
    const displayTime = `${displayHour}:${formattedMinute} ${displayPeriod}`;

    return { hour, minute, timeStr, displayTime };
  }

  return null;
}
