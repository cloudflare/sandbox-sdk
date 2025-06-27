import {
  HttpClient,
  quickExecute,
  quickExecuteStream,
} from "../../sandbox/src/client";
import { isMain } from "./common";

async function testHttpClient() {
  console.log("🚀 Testing HTTP Client...\n");

  // Create a client instance
  const client = new HttpClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (success, exitCode, stdout, stderr, command, args) => {
      console.log(
        `✅ Command completed: ${command}, Success: ${success}, Exit code: ${exitCode}`
      );
    },
    onCommandStart: (command, args) => {
      console.log(`📝 Command started: ${command} ${args.join(" ")}`);
    },
    onError: (error, command, args) => {
      console.error(`❌ Command error: ${error}`);
    },
    onOutput: (stream, data, command) => {
      console.log(`📤 [${stream}] ${data.trim()}`);
    },
  });

  try {
    // Test ping
    console.log("1. Testing ping...");
    const pingTime = await client.ping();
    console.log(`   Ping response time: ${pingTime}\n`);

    // Test getting available commands
    console.log("2. Testing get commands...");
    const commands = await client.getCommands();
    console.log(`   Available commands: ${commands.join(", ")}\n`);

    // Test session creation
    console.log("3. Testing session creation...");
    const sessionId = await client.createSession();
    console.log(`   Created session: ${sessionId}\n`);

    // Test listing sessions
    console.log("4. Testing session listing...");
    const sessions = await client.listSessions();
    console.log(`   Active sessions: ${sessions.count}\n`);

    // Test regular command execution
    console.log("5. Testing regular command execution...");
    const result = await client.execute("echo", ["Hello from HTTP client!"]);
    console.log(`   Command result: ${result.stdout.trim()}\n`);

    // Test another command
    console.log("6. Testing another command...");
    const pwdResult = await client.execute("pwd");
    console.log(`   Current directory: ${pwdResult.stdout.trim()}\n`);

    // Test streaming command execution
    console.log("7. Testing streaming command execution...");
    await client.executeStream("ls", ["-la"]);
    console.log("   Streaming command completed\n");

    // Test quick execute utility
    console.log("8. Testing quick execute utility...");
    const quickResult = await quickExecute("whoami");
    console.log(`   Quick execute result: ${quickResult.stdout.trim()}\n`);

    console.log("🎉 All tests completed successfully!");
  } catch (error) {
    console.error("❌ Test failed:", error);
  }
}

// Run the test if this file is executed directly
if (isMain) {
  testHttpClient().catch(console.error);
}

export { testHttpClient };
