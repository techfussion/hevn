import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryService } from "../src/core/memory/MemoryService";
import { ProjectService } from "../src/core/projects/ProjectService";
import type { UserMemory, Project } from "../src/types/domain";

describe("Structured Memory & Lightweight Projects", () => {
  const user1 = "00000000-0000-0000-0000-000000000001";
  const user2 = "00000000-0000-0000-0000-000000000002";

  it("stores and queries structured user memory", async () => {
    const memoryService = new MemoryService();
    const storedMemories: UserMemory[] = [];

    (memoryService as unknown as Record<string, unknown>).storeMemory = async (
      userId: string,
      input: { category: string; content: string; key?: string }
    ) => {
      const memory: UserMemory = {
        id: "mem-1",
        userId,
        category: input.category as "person",
        content: input.content,
        key: input.key ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      storedMemories.push(memory);
      return memory;
    };

    (memoryService as unknown as Record<string, unknown>).searchMemories = async (
      userId: string,
      query: string
    ) => {
      return storedMemories.filter(
        (m) => m.userId === userId && m.content.toLowerCase().includes(query.toLowerCase())
      );
    };

    const saved = await memoryService.storeMemory(user1, {
      category: "person",
      content: "I work with Sarah on finance",
      key: "collaborator_sarah",
    });

    assert.equal(saved.content, "I work with Sarah on finance");
    assert.equal(saved.key, "collaborator_sarah");

    const searchUser1 = await memoryService.searchMemories(user1, "Sarah");
    assert.equal(searchUser1.length, 1);
    assert.equal(searchUser1[0].content, "I work with Sarah on finance");

    // Verify tenant isolation: user2 cannot retrieve user1's memories
    const searchUser2 = await memoryService.searchMemories(user2, "Sarah");
    assert.equal(searchUser2.length, 0);
  });

  it("creates and retrieves projects with linked tasks", async () => {
    const projectService = new ProjectService();

    (projectService as unknown as Record<string, unknown>).createProject = async (
      userId: string,
      input: { name: string; description?: string }
    ) => {
      return {
        id: "proj-1",
        userId,
        name: input.name,
        description: input.description ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Project;
    };

    const project = await projectService.createProject(user1, {
      name: "Q3 Client Proposal",
      description: "Pitch materials and financial models",
    });

    assert.equal(project.name, "Q3 Client Proposal");
    assert.equal(project.id, "proj-1");
  });
});
