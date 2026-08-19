import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

const isoDateTime = z
  .string()
  .refine((val) => !isNaN(Date.parse(val)), { message: "Invalid datetime" })
  .transform((val) => new Date(val).toISOString());

const reminderOffsetField = z.preprocess(
  (val) => (typeof val === "number" ? Math.abs(Math.trunc(val)) : val),
  z.number().int().min(0).max(60 * 24 * 14).nullable().optional()
);

const createTaskSchema = z.object({
  title: z.string().min(1).max(200),
  dueAtIso: isoDateTime,
  priority: z.enum(["low", "medium", "high"]),
  reminderOffsetMinutes: reminderOffsetField,
});

const breakdownSchema = z.object({
  subtasks: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        dueAtIso: isoDateTime,
        priority: z.enum(["low", "medium", "high"]),
        reminderOffsetMinutes: reminderOffsetField,
      })
    )
    .min(1)
    .max(15),
});

describe("Domain Validation & Task Schemas", () => {
  it("validates and normalizes valid task creation input", () => {
    const raw = {
      title: "Complete Physics Lab 4",
      dueAtIso: "2026-09-01T18:00:00Z",
      priority: "high",
      reminderOffsetMinutes: 30,
    };

    const parsed = createTaskSchema.parse(raw);
    assert.equal(parsed.title, "Complete Physics Lab 4");
    assert.equal(parsed.priority, "high");
    assert.equal(parsed.reminderOffsetMinutes, 30);
    assert.equal(parsed.dueAtIso, "2026-09-01T18:00:00.000Z");
  });

  it("rejects invalid ISO dates", () => {
    const raw = {
      title: "Invalid date task",
      dueAtIso: "not-a-real-date",
      priority: "medium",
    };

    assert.throws(() => createTaskSchema.parse(raw));
  });

  it("rejects empty title or title exceeding 200 characters", () => {
    assert.throws(() =>
      createTaskSchema.parse({
        title: "",
        dueAtIso: "2026-09-01T18:00:00Z",
        priority: "low",
      })
    );

    assert.throws(() =>
      createTaskSchema.parse({
        title: "A".repeat(201),
        dueAtIso: "2026-09-01T18:00:00Z",
        priority: "low",
      })
    );
  });

  it("validates multi-step task breakdown schema", () => {
    const breakdown = {
      subtasks: [
        { title: "Literature Review", dueAtIso: "2026-09-10T12:00:00Z", priority: "medium" },
        { title: "Draft Proposal", dueAtIso: "2026-09-15T12:00:00Z", priority: "high" },
        { title: "Final Proofread", dueAtIso: "2026-09-20T12:00:00Z", priority: "low" },
      ],
    };

    const parsed = breakdownSchema.parse(breakdown);
    assert.equal(parsed.subtasks.length, 3);
    assert.equal(parsed.subtasks[0].title, "Literature Review");
  });

  it("clamps and validates snooze minute values", () => {
    const clampSnooze = (snoozeMinutes: number) =>
      Math.min(Math.max(Math.floor(snoozeMinutes), 1), 60 * 24 * 7);

    assert.equal(clampSnooze(30), 30);
    assert.equal(clampSnooze(-10), 1); // minimum 1 minute
    assert.equal(clampSnooze(999999), 10080); // max 7 days (10080 minutes)
  });
});
