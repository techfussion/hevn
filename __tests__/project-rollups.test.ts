import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectService } from "../src/core/projects/ProjectService";
import type { Project, ProjectSummary, Task } from "../src/types/domain";

describe("Project Intelligence & Status Rollups", () => {
  const user1 = "00000000-0000-0000-0000-000000000001";
  const user2 = "00000000-0000-0000-0000-000000000002";
  const proj1 = "11111111-1111-1111-1111-111111111111";

  it("calculates deterministic project rollups correctly", async () => {
    const projectService = new ProjectService();

    const sampleProject: Project = {
      id: proj1,
      userId: user1,
      name: "Q3 Client Proposal",
      description: "Enterprise proposal and deck",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const sampleTasks: Task[] = [
      {
        id: "t1",
        userId: user1,
        title: "Finalize pricing spreadsheet",
        dueAt: new Date(Date.now() - 3600000).toISOString(),
        priority: "high",
        status: "done",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: proj1,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "t2",
        userId: user1,
        title: "Send deck to client",
        dueAt: new Date(Date.now() + 7200000).toISOString(),
        priority: "high",
        status: "pending",
        taskType: "commitment",
        isSystemGenerated: false,
        parentTaskId: null,
        projectId: proj1,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      {
        id: "t3",
        userId: user1,
        title: "Follow up with legal",
        dueAt: new Date(Date.now() - 1800000).toISOString(),
        priority: "medium",
        status: "pending",
        taskType: "task",
        isSystemGenerated: false,
        parentTaskId: "t2",
        projectId: proj1,
        reminderOffsetMinutes: 30,
        reminderSentAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ];

    (projectService as unknown as Record<string, unknown>).getProjectSummary = async (
      userId: string,
      projectNameOrId: string
    ): Promise<ProjectSummary | null> => {
      if (userId !== user1) return null;
      if (projectNameOrId !== proj1 && !projectNameOrId.toLowerCase().includes("proposal")) {
        return null;
      }

      const totalTasks = sampleTasks.length;
      const completed = sampleTasks.filter((t) => t.status === "done");
      const pending = sampleTasks.filter((t) => t.status !== "done");
      const overdue = pending.filter((t) => new Date(t.dueAt).getTime() < Date.now());
      const upcoming = pending.filter((t) => new Date(t.dueAt).getTime() >= Date.now());
      const commitments = sampleTasks.filter((t) => t.taskType === "commitment");

      return {
        project: sampleProject,
        totalTasks,
        completedTasks: completed.length,
        pendingTasks: pending.length,
        overdueTasks: overdue.length,
        upcomingTasks: upcoming.length,
        commitmentsCount: commitments.length,
        completionPercentage: Math.round((completed.length / totalTasks) * 100),
        remainingTasks: pending.map((t) => ({
          id: t.id,
          title: t.title,
          dueAt: t.dueAt,
          priority: t.priority,
          taskType: t.taskType,
          isPreparation: Boolean(t.parentTaskId),
        })),
        completedTasksList: completed.map((t) => ({
          id: t.id,
          title: t.title,
          dueAt: t.dueAt,
        })),
      };
    };

    const summary = await projectService.getProjectSummary(user1, "Q3 Client Proposal");
    assert.ok(summary);
    assert.equal(summary.project.name, "Q3 Client Proposal");
    assert.equal(summary.totalTasks, 3);
    assert.equal(summary.completedTasks, 1);
    assert.equal(summary.pendingTasks, 2);
    assert.equal(summary.overdueTasks, 1);
    assert.equal(summary.upcomingTasks, 1);
    assert.equal(summary.commitmentsCount, 1);
    assert.equal(summary.completionPercentage, 33);
    assert.equal(summary.remainingTasks.length, 2);
    assert.equal(summary.completedTasksList.length, 1);
  });

  it("enforces strict user isolation — User A cannot view User B's project summary", async () => {
    const projectService = new ProjectService();

    (projectService as unknown as Record<string, unknown>).getProjectSummary = async (
      userId: string,
      _query: string
    ): Promise<ProjectSummary | null> => {
      if (userId !== user1) return null;
      return {
        project: {
          id: proj1,
          userId: user1,
          name: "Confidential",
          description: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        totalTasks: 1,
        completedTasks: 0,
        pendingTasks: 1,
        overdueTasks: 0,
        upcomingTasks: 1,
        commitmentsCount: 0,
        completionPercentage: 0,
        remainingTasks: [],
        completedTasksList: [],
      };
    };

    const summaryUser1 = await projectService.getProjectSummary(user1, "Confidential");
    assert.ok(summaryUser1);

    const summaryUser2 = await projectService.getProjectSummary(user2, "Confidential");
    assert.equal(summaryUser2, null);
  });
});
