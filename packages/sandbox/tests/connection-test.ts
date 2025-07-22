import { HttpClient } from "../../sandbox/src/client";

async function connectionTest() {
  console.log("🔌 Testing HTTP Connection Only");

  const client = new HttpClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (
      success: boolean,
      exitCode: number,
      stdout: string,
      stderr: string,
      command: string,
    ) => {
      console.log(
        `✅ Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
      );
    },
    onCommandStart: (command: string) => {
      console.log("📝 Command started:", command);
    },
    onError: (error: string, command?: string) => {
      console.error(`❌ Error: ${error}`);
    },
    onOutput: (stream: "stdout" | "stderr", data: string, command: string) => {
      console.log(`📤 [${stream}] ${data.trim()}`);
    },
  });

  try {
    // Test ping to verify server is reachable
    console.log("🏓 Testing ping...");
    const pingResult = await client.ping();
    console.log("✅ Ping successful:", pingResult);

    // Create a session
    console.log("🔗 Creating session...");
    const sessionId = await client.createSession();
    console.log("✅ Session created:", sessionId);

    // Test getting available commands
    console.log("📋 Getting available commands...");
    const commands = await client.getCommands();
    console.log("✅ Available commands:", commands.length);

    // Test listing sessions
    console.log("📝 Listing sessions...");
    const sessions = await client.listSessions();
    console.log("✅ Active sessions:", sessions.count);

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 1000));

    console.log("✅ Connection test successful");
  } catch (error) {
    console.error("❌ Connection test failed:", error);
    throw error;
  } finally {
    client.clearSession();
    console.log("🔌 Session cleared");
  }
}

// Add a timeout to prevent hanging
const timeout = setTimeout(() => {
  console.error("❌ Connection test timed out after 15 seconds");
  process.exit(1);
}, 15000);

connectionTest()
  .then(() => {
    clearTimeout(timeout);
    console.log("✅ Connection test finished successfully");
    process.exit(0);
  })
  .catch((error) => {
    clearTimeout(timeout);
    console.error("❌ Connection test failed:", error);
    process.exit(1);
  });
