import { z } from "zod";
import { withUserScope } from "../../db/pool";
import type { Project, Task, TaskPriority, TaskStatus, TaskType, ProjectSummary } from "../../types/domain";

const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
});

export class ProjectService {
  async createProject(userId: string, input: unknown): Promise<Project> {
    const parsed = createProjectSchema.parse(input);

    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO projects (user_id, name, description)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [userId, parsed.name, parsed.description ?? null]
      );
      return mapProjectRow(rows[0]);
    });
  }

  async getProjects(userId: string): Promise<Project[]> {
    return withUserScope(userId, async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at ASC`,
        [userId]
      );
      return rows.map(mapProjectRow);
    });
  }

  async getProjectWithTasks(
    userId: string,
    projectId: string
  ): Promise<{ project: Project | null; tasks: Task[] }> {
    if (!isUuid(projectId)) return { project: null, tasks: [] };

    return withUserScope(userId, async (client) => {
      const { rows: pRows } = await client.query(
        `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
        [projectId, userId]
      );
      if (!pRows[0]) return { project: null, tasks: [] };

      const { rows: tRows } = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND user_id = $2 ORDER BY due_at ASC`,
        [projectId, userId]
      );

      return {
        project: mapProjectRow(pRows[0]),
        tasks: tRows.map(mapTaskRow),
      };
    });
  }

  /**
   * Deterministically calculates project rollups and status metrics.
   * Matches by project UUID or case-insensitive name.
   */
  async getProjectSummary(userId: string, projectNameOrId: string): Promise<ProjectSummary | null> {
    const query = projectNameOrId.trim();
    if (!query) return null;

    return withUserScope(userId, async (client) => {
      let projectRow: Record<string, unknown> | undefined;

      if (isUuid(query)) {
        const { rows } = await client.query(
          `SELECT * FROM projects WHERE id = $1 AND user_id = $2`,
          [query, userId]
        );
        projectRow = rows[0];
      } else {
        const { rows } = await client.query(
          `SELECT * FROM projects WHERE user_id = $1 AND name ILIKE ('%' || $2 || '%') ORDER BY created_at DESC LIMIT 1`,
          [userId, query]
        );
        projectRow = rows[0];
      }

      if (!projectRow) return null;

      const project = mapProjectRow(projectRow);
      const { rows: taskRows } = await client.query(
        `SELECT * FROM tasks WHERE project_id = $1 AND user_id = $2 ORDER BY due_at ASC`,
        [project.id, userId]
      );

      const tasks = taskRows.map(mapTaskRow);
      const now = new Date().getTime();

      let completedCount = 0;
      let pendingCount = 0;
      let overdueCount = 0;
      let upcomingCount = 0;
      let commitmentsCount = 0;

      const remainingTasks: ProjectSummary["remainingTasks"] = [];
      const completedTasksList: ProjectSummary["completedTasksList"] = [];

      for (const t of tasks) {
        if (t.taskType === "commitment") {
          commitmentsCount++;
        }

        if (t.status === "done") {
          completedCount++;
          completedTasksList.push({
            id: t.id,
            title: t.title,
            dueAt: t.dueAt,
          });
        } else {
          pendingCount++;
          const dueTime = new Date(t.dueAt).getTime();
          if (dueTime < now) {
            overdueCount++;
          } else {
            upcomingCount++;
          }

          remainingTasks.push({
            id: t.id,
            title: t.title,
            dueAt: t.dueAt,
            priority: t.priority,
            taskType: t.taskType,
            isPreparation: Boolean(t.parentTaskId),
          });
        }
      }

      const totalTasks = tasks.length;
      const completionPercentage = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0;

      return {
        project,
        totalTasks,
        completedTasks: completedCount,
        pendingTasks: pendingCount,
        overdueTasks: overdueCount,
        upcomingTasks: upcomingCount,
        commitmentsCount,
        completionPercentage,
        remainingTasks,
        completedTasksList,
      };
    });
  }

  async linkTaskToProject(userId: string, taskId: string, projectId: string | null): Promise<boolean> {
    if (!isUuid(taskId) || (projectId && !isUuid(projectId))) return false;

    return withUserScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE tasks SET project_id = $1 WHERE id = $2 AND user_id = $3`,
        [projectId, taskId, userId]
      );
      return (rowCount ?? 0) > 0;
    });
  }

  async deleteProject(userId: string, projectId: string): Promise<boolean> {
    if (!isUuid(projectId)) return false;

    return withUserScope(userId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM projects WHERE id = $1 AND user_id = $2`,
        [projectId, userId]
      );
      return (rowCount ?? 0) > 0;
    });
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function mapProjectRow(row: Record<string, unknown>): Project {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string,
    dueAt: (row.due_at as Date).toISOString(),
    priority: (row.priority as TaskPriority) || "medium",
    status: (row.status as TaskStatus) || "pending",
    taskType: ((row.task_type as string) || "task") as TaskType,
    isSystemGenerated: Boolean(row.is_system_generated),
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    projectId: (row.project_id as string | null) ?? null,
    reminderOffsetMinutes: (row.reminder_offset_minutes as number | null) ?? null,
    reminderSentAt: row.reminder_sent_at ? (row.reminder_sent_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  };
}
