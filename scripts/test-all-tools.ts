import "dotenv/config";
import { GemmaClient } from "../src/core/gemma/GemmaClient";
import { TaskService } from "../src/core/tasks/TaskService";
import { InsightsService } from "../src/core/insights/InsightsService";
import { UserService } from "../src/core/tasks/UserService";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";

/**
 * Exercises every tool case end-to-end and checks that no raw
 * chain-of-thought leaks into the reply. Run with: npx tsx scripts/test-all-tools.ts
 */

const TEST_USER_ID = "tool-test-user";

const CONVERSATION: string[] = [
  "Remind me to submit my AI assignment tomorrow at 6pm",           // create_task
  "Actually make that due at 8pm instead",                          // update_task
  "What's on my plate?",                                            // get_upcoming_tasks
  "Mark the assignment as done",                                    // mark_task_status
  "I have a research project due in three weeks",                   // create_task_breakdown
  "Push my next task back by an hour",                              // snooze_task
  "How am I doing this week?",                                      // get_weekly_report
];

// Phrases that indicate leaked reasoning rather than a clean reply.
const LEAK_INDICATORS = ["the user", "i need to", "i will call", "i should", "assuming the tool"];

async function main() {
  const gemma = new GemmaClient(process.env.GEMMA_API_KEY!, process.env.GEMMA_MODEL ?? "gemma-4-31b-it");
  const taskService = new TaskService();
  const insightsService = new InsightsService();
  const userService = new UserService();
  const orchestrator = new ConversationOrchestrator(gemma, taskService, userService, insightsService);

  const user = await userService.getOrCreate("telegram", TEST_USER_ID);

  for (const msg of CONVERSATION) {
    console.log(`\nYou: ${msg}`);
    const reply = await orchestrator.handleMessage(user, msg);
    console.log(`Bot: ${reply}`);

    const lower = reply.toLowerCase();
    const leaked = LEAK_INDICATORS.some((phrase) => lower.includes(phrase));
    if (leaked) {
      console.warn("⚠️  Possible chain-of-thought leak detected in reply above.");
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  console.log("\nDone. Review each reply above manually — the warnings are a heuristic, not proof.");
  process.exit(0);
}

main().catch((err) => {
  console.error("❌ test-all-tools failed:", err);
  process.exit(1);
});