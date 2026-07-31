import "dotenv/config";
import readline from "readline";
import { GemmaClient } from "../src/core/gemma/GemmaClient";
import { TaskService } from "../src/core/tasks/TaskService";
import { UserService } from "../src/core/tasks/UserService";
import { ConversationOrchestrator } from "../src/orchestrator/ConversationOrchestrator";
import { InsightsService } from "../src/core/insights/InsightsService";

/**
 * Local terminal chat loop — exercises the full orchestrator (Gemma +
 * tool calls + Postgres) without needing Telegram, a webhook, or ngrok.
 * Fastest way to iterate on prompts/tool logic during demo.
 *
 * Requires: GEMMA_API_KEY and DATABASE_URL set in .env, and schema.sql
 * already applied to database.
 *
 * Run with: npx tsx scripts/chat-cli.ts
 */

const CLI_TEST_USER_ID = "cli-tester"; // fake platform_user_id, isolated from real Telegram users

async function main() {
  const apiKey = process.env.GEMMA_API_KEY;
  if (!apiKey) {
    console.error("❌ GEMMA_API_KEY not set.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("❌ DATABASE_URL not set.");
    process.exit(1);
  }

  const gemma = new GemmaClient(apiKey, process.env.GEMMA_MODEL ?? "gemma-4-31b-it");
  const taskService = new TaskService();
  const insightsService = new InsightsService();
  const userService = new UserService();
  const orchestrator = new ConversationOrchestrator(gemma, taskService, userService, insightsService);

  const user = await userService.getOrCreate("telegram", CLI_TEST_USER_ID);
  console.log(`\n💬 Chatting as test user (${user.id}). Type 'exit' to quit.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = () =>
    rl.question("You: ", async (input) => {
      if (input.trim().toLowerCase() === "exit") {
        rl.close();
        process.exit(0);
      }
      try {
        const reply = await orchestrator.handleMessage(user, input);
        console.log(`Bot: ${reply}\n`);
      } catch (err) {
        console.error("❌ Error:", err);
      }
      ask();
    });

  ask();
}

main();