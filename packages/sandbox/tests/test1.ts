import { HttpClient } from "../../sandbox/src/client";

interface ExecuteRequest {
  command: string;
}

class HttpCommandTester {
  private client: HttpClient;
  private sessionId: string | null = null;

  constructor(private baseUrl: string) {
    this.client = new HttpClient({
      baseUrl,
      onCommandComplete: (
        success: boolean,
        exitCode: number,
        stdout: string,
        stderr: string,
        command: string,
      ) => {
        const successIcon = success ? "✅" : "❌";
        console.log(
          `${successIcon} Command completed with exit code: ${exitCode}`
        );
        if (stderr) {
          console.log(`❌ Final stderr: ${stderr.trim()}`);
        }
      },
      onCommandStart: (command: string) => {
        console.log(`🚀 Starting command: ${command}`);
      },
      onError: (error: string, command?: string) => {
        console.error(`❌ Error: ${error}`);
      },
      onOutput: (
        stream: "stdout" | "stderr",
        data: string,
        command: string
      ) => {
        const streamLabel = stream === "stderr" ? "❌ STDERR" : "📤 STDOUT";
        console.log(`${streamLabel}: ${data.trim()}`);
      },
      onStreamEvent: (event) => {
        console.log(`📡 Stream event: ${event.type}`);
      },
    });
  }

  async connect(): Promise<void> {
    try {
      // Test ping to verify server is reachable
      console.log("🏓 Testing ping...");
      const pingResult = await this.client.ping();
      console.log("✅ Ping successful:", pingResult);

      // Create a session
      console.log("🔗 Creating session...");
      this.sessionId = await this.client.createSession();
      console.log("✅ Session created:", this.sessionId);
    } catch (error) {
      console.error("❌ Failed to connect:", error);
      throw error;
    }
  }

  async executeCommand(command: string): Promise<void> {
    console.log(`\n🔧 Executing: ${command}`);

    try {
      const result = await this.client.execute(
        command,
        this.sessionId || undefined
      );
      console.log(`✅ Command executed successfully`);
    } catch (error) {
      console.error(`❌ Command execution failed:`, error);
    }
  }

  async executeStreamingCommand(
    command: string
  ): Promise<void> {
    console.log(`\n🔧 Executing streaming: ${command}`);

    try {
      await this.client.executeStream(
        command,
        this.sessionId || undefined
      );
      console.log(`✅ Streaming command completed`);
    } catch (error) {
      console.error(`❌ Streaming command failed:`, error);
    }
  }

  async ping(): Promise<void> {
    console.log("\n🏓 Sending ping...");
    try {
      const result = await this.client.ping();
      console.log(`✅ Ping successful: ${result}`);
    } catch (error) {
      console.error(`❌ Ping failed:`, error);
    }
  }

  async listCommands(): Promise<void> {
    console.log("\n📋 Requesting available commands...");
    try {
      const commands = await this.client.getCommands();
      console.log(`✅ Available commands: ${commands.join(", ")}`);
    } catch (error) {
      console.error(`❌ Failed to get commands:`, error);
    }
  }

  async listSessions(): Promise<void> {
    console.log("\n📝 Listing sessions...");
    try {
      const sessions = await this.client.listSessions();
      console.log(`✅ Active sessions: ${sessions.count}`);
      sessions.sessions.forEach((session) => {
        console.log(
          `   - ${session.sessionId} (active: ${session.hasActiveProcess})`
        );
      });
    } catch (error) {
      console.error(`❌ Failed to list sessions:`, error);
    }
  }

  async testDangerousCommand(): Promise<void> {
    console.log("\n⚠️  Testing dangerous command protection...");
    try {
      await this.client.execute(
        "rm -rf /",
        this.sessionId || undefined
      );
    } catch (error) {
      console.log("✅ Dangerous command correctly blocked");
    }
  }

  async testInvalidCommand(): Promise<void> {
    console.log("\n❓ Testing invalid command...");
    try {
      await this.client.execute(
        "nonexistentcommand12345",
        this.sessionId || undefined
      );
    } catch (error) {
      console.log("✅ Invalid command handled gracefully");
    }
  }

  async testLongRunningCommand(): Promise<void> {
    console.log("\n⏱️  Testing long-running command...");
    try {
      await this.client.execute("sleep 3", this.sessionId || undefined);
      console.log("✅ Long-running command completed");
    } catch (error) {
      console.error(`❌ Long-running command failed:`, error);
    }
  }

  async testStreamingCommand(): Promise<void> {
    console.log("\n📡 Testing streaming command...");
    try {
      await this.client.executeStream(
        "ls -la",
        this.sessionId || undefined
      );
      console.log("✅ Streaming command completed");
    } catch (error) {
      console.error(`❌ Streaming command failed:`, error);
    }
  }

  async testQuickExecute(): Promise<void> {
    console.log("\n⚡ Testing quick execute...");
    try {
      const { quickExecute } = await import("../../sandbox/src/client");
      const result = await quickExecute("echo \"Hello from quick execute!\"");
      console.log(`✅ Quick execute result: ${result.stdout.trim()}`);
    } catch (error) {
      console.error(`❌ Quick execute failed:`, error);
    }
  }

  async testQuickExecuteStream(): Promise<void> {
    console.log("\n⚡ Testing quick execute stream...");
    try {
      const { quickExecuteStream } = await import("../../sandbox/src/client");
      await quickExecuteStream("echo \"Hello from quick execute stream!\"");
      console.log("✅ Quick execute stream completed");
    } catch (error) {
      console.error(`❌ Quick execute stream failed:`, error);
    }
  }

  disconnect(): void {
    if (this.client) {
      this.client.clearSession();
      console.log("🔌 Session cleared");
    }
  }
}

async function runTests(): Promise<void> {
  const tester = new HttpCommandTester("http://127.0.0.1:3000");

  try {
    console.log("🚀 Starting HTTP command execution tests...\n");

    // Connect to the server
    await tester.connect();

    // Wait a moment for connection to stabilize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Test 1: List available commands
    await tester.listCommands();

    // Test 2: List sessions
    await tester.listSessions();

    // Test 3: Ping the server
    await tester.ping();

    // Test 4: Simple echo command
    await tester.executeCommand("echo \"Hello from HTTP!\"");

    // Test 5: List current directory
    await tester.executeCommand("ls -la");

    // Test 6: Get current working directory
    await tester.executeCommand("pwd");

    // Test 7: Check system info
    await tester.executeCommand("uname -a");

    // Test 8: Test streaming command
    await tester.testStreamingCommand();

    // Test 9: Test quick execute
    await tester.testQuickExecute();

    // Test 10: Test quick execute stream
    await tester.testQuickExecuteStream();

    // Test 11: Test dangerous command protection
    await tester.testDangerousCommand();

    // Test 12: Test invalid command
    await tester.testInvalidCommand();

    // Test 13: Test long-running command
    await tester.testLongRunningCommand();

    console.log("\n✅ All tests completed!");
  } catch (error) {
    console.error("❌ Test failed:", error);
  } finally {
    // Clean up
    setTimeout(() => {
      tester.disconnect();
      console.log("\n🔌 Test completed, disconnecting...");
      process.exit(0);
    }, 1000);
  }
}

// Run the tests
runTests().catch(console.error);
