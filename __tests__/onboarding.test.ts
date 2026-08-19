import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OnboardingService,
  extractName,
  matchAssistantName,
  matchPersona,
  parseCheckinTime,
} from "../src/core/onboarding/OnboardingService";
import { UserService } from "../src/core/tasks/UserService";
import { TaskService } from "../src/core/tasks/TaskService";
import type { User, OnboardingState, UserPersona, Task } from "../src/types/domain";

describe("Conversational Onboarding State Machine", () => {
  function createTestUser(overrides: Partial<User> = {}): User {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      platform: "telegram",
      platformUserId: "123456",
      displayName: null,
      timezone: "Africa/Lagos",
      onboarded: false,
      onboardingState: "WELCOME",
      assistantName: "Hevn",
      botPersona: "Hevn",
      persona: "professional",
      preferredCheckinTime: "06:00",
      preferredCheckinHour: 6,
      plan: "free",
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  describe("Helper Parsers", () => {
    it("extracts names from natural language responses", () => {
      assert.equal(extractName("Abdulhameed"), "Abdulhameed");
      assert.equal(extractName("My name is Sarah"), "Sarah");
      assert.equal(extractName("I'm Raj"), "Raj");
      assert.equal(extractName("Call me Alex"), "Alex");
      assert.equal(extractName(""), null);
    });

    it("matches assistant name choices against canonical CTO brief options", () => {
      assert.equal(matchAssistantName("Mumin"), "Mumin");
      assert.equal(matchAssistantName("1"), "Mumin");
      assert.equal(matchAssistantName("the first one"), "Mumin");
      assert.equal(matchAssistantName("Khadijah"), "Khadijah");
      assert.equal(matchAssistantName("khadija"), "Khadijah");
      assert.equal(matchAssistantName("Scott"), "Scott");
      assert.equal(matchAssistantName("I'll go with Scott"), "Scott");
      assert.equal(matchAssistantName("Claire"), "Claire");
      assert.equal(matchAssistantName("4"), "Claire");
      assert.equal(matchAssistantName("Jarvis"), null);
    });

    it("matches user persona options against Student, Executive Assistant, and Professional", () => {
      assert.equal(matchPersona("Student"), "student");
      assert.equal(matchPersona("1"), "student");
      assert.equal(matchPersona("academic"), "student");
      assert.equal(matchPersona("Executive Assistant"), "executive_assistant");
      assert.equal(matchPersona("EA"), "executive_assistant");
      assert.equal(matchPersona("2"), "executive_assistant");
      assert.equal(matchPersona("Professional"), "professional");
      assert.equal(matchPersona("I work as a developer"), "professional");
      assert.equal(matchPersona("3"), "professional");
      assert.equal(matchPersona("something else"), null);
    });

    it("parses diverse natural language check-in times", () => {
      // Default / acceptance
      const def = parseCheckinTime("6am is fine");
      assert.ok(def);
      assert.equal(def.hour, 6);
      assert.equal(def.timeStr, "06:00");
      assert.equal(def.displayTime, "6:00 AM");

      const def2 = parseCheckinTime("keep 6am");
      assert.ok(def2);
      assert.equal(def2.hour, 6);

      // Custom times
      const t8 = parseCheckinTime("8am");
      assert.ok(t8);
      assert.equal(t8.hour, 8);
      assert.equal(t8.timeStr, "08:00");
      assert.equal(t8.displayTime, "8:00 AM");

      const t730 = parseCheckinTime("7:30");
      assert.ok(t730);
      assert.equal(t730.hour, 7);
      assert.equal(t730.minute, 30);
      assert.equal(t730.timeStr, "07:30");
      assert.equal(t730.displayTime, "7:30 AM");

      const t10 = parseCheckinTime("10 in the morning");
      assert.ok(t10);
      assert.equal(t10.hour, 10);
      assert.equal(t10.timeStr, "10:00");

      const invalid = parseCheckinTime("whenever you like");
      assert.equal(invalid, null);
    });
  });

  describe("End-to-End Conversational Onboarding Flow", () => {
    it("guides a new user from First Contact through Full Onboarding", async () => {
      let currentState: OnboardingState = "WELCOME";
      let storedName: string | null = null;
      let storedAssistant: string | null = null;
      let storedPersona: UserPersona | null = null;
      let storedCheckin: string | null = null;
      let recurringTaskCreated = false;

      const mockUserService = {
        setOnboardingState: async (_id: string, s: OnboardingState) => {
          currentState = s;
        },
        setDisplayName: async (_id: string, name: string) => {
          storedName = name;
        },
        setAssistantName: async (_id: string, a: string) => {
          storedAssistant = a;
        },
        setPersona: async (_id: string, p: UserPersona) => {
          storedPersona = p;
        },
        setCheckinTime: async (_id: string, t: string, _h: number) => {
          storedCheckin = t;
        },
      } as unknown as UserService;

      const mockTaskService = {
        ensureDailyCheckinTask: async (_id: string, _t: string): Promise<Task> => {
          recurringTaskCreated = true;
          return {} as Task;
        },
      } as unknown as TaskService;

      const onboarding = new OnboardingService(mockUserService, mockTaskService);

      // 1. First Contact: User says "Hi"
      let user = createTestUser({ onboardingState: currentState });
      let reply = await onboarding.handleOnboardingMessage(user, "Hi");
      assert.ok(reply.includes("Welcome to Hevn"));
      assert.ok(reply.includes("what should I call you?"));
      assert.equal(currentState, "AWAITING_NAME");

      // 2. User provides name: "Abdulhameed"
      user = createTestUser({ onboardingState: currentState });
      reply = await onboarding.handleOnboardingMessage(user, "Abdulhameed");
      assert.ok(reply.includes("Nice to meet you, Abdulhameed"));
      assert.ok(reply.includes("Mumin"));
      assert.ok(reply.includes("Scott"));
      assert.ok(reply.includes("Claire"));
      assert.equal(storedName, "Abdulhameed");
      assert.equal(currentState, "AWAITING_ASSISTANT_NAME");

      // 3. User selects assistant name: "Scott"
      user = createTestUser({ onboardingState: currentState, displayName: storedName });
      reply = await onboarding.handleOnboardingMessage(user, "I'll go with Scott");
      assert.ok(reply.includes("Scott it is"));
      assert.ok(reply.includes("Student"));
      assert.ok(reply.includes("Executive Assistant"));
      assert.ok(reply.includes("Professional"));
      assert.equal(storedAssistant, "Scott");
      assert.equal(currentState, "AWAITING_PERSONA");

      // 3b. User asks for explanation: "Explain them"
      user = createTestUser({ onboardingState: currentState, assistantName: storedAssistant! });
      reply = await onboarding.handleOnboardingMessage(user, "Explain them first");
      assert.ok(reply.includes("Student"));
      assert.ok(reply.includes("Executive Assistant"));
      assert.ok(reply.includes("Professional"));
      assert.ok(reply.includes("assignments, exams, projects"));
      assert.equal(currentState, "AWAITING_PERSONA"); // Remains in persona state!

      // 4. User selects persona: "Professional"
      user = createTestUser({ onboardingState: currentState, assistantName: storedAssistant! });
      reply = await onboarding.handleOnboardingMessage(user, "Professional");
      assert.ok(reply.includes("tailor how I help you"));
      assert.ok(reply.includes("check in"));
      assert.ok(reply.includes("6:00 AM"));
      assert.equal(storedPersona, "professional");
      assert.equal(currentState, "AWAITING_CHECKIN_TIME");

      // 5. User selects checkin time: "7:30am"
      user = createTestUser({
        onboardingState: currentState,
        assistantName: storedAssistant!,
        persona: storedPersona!,
      });
      reply = await onboarding.handleOnboardingMessage(user, "7:30am");
      assert.ok(reply.includes("Perfect. You're all set."));
      assert.ok(reply.includes("7:30 AM"));
      assert.ok(reply.includes("So, what's on your mind?"));
      assert.equal(storedCheckin, "07:30");
      assert.equal(currentState, "COMPLETED");
      assert.equal(recurringTaskCreated, true);
    });

    it("resumes gracefully if user returns mid-flow without restarting", async () => {
      const mockUserService = {
        setOnboardingState: async () => {},
        setAssistantName: async () => {},
      } as unknown as UserService;

      const onboarding = new OnboardingService(mockUserService);

      // User stopped at AWAITING_ASSISTANT_NAME and comes back with invalid response
      const user = createTestUser({
        displayName: "Raj",
        onboardingState: "AWAITING_ASSISTANT_NAME",
      });

      const reply = await onboarding.handleOnboardingMessage(user, "What were my choices again?");
      assert.ok(reply.includes("Please pick one of these names for me"));
      assert.ok(reply.includes("Mumin"));
      assert.ok(reply.includes("Scott"));
    });
  });
});
