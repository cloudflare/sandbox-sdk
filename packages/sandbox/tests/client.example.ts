import {
  createClient,
  quickExecute,
  quickExecuteStream,
  quickGitCheckout,
  quickGitCheckoutStream,
  quickMkdir,
  quickMkdirStream,
} from "../../sandbox/src/client";

// Example 1: Basic client usage
async function basicExample() {
  console.log("=== Basic Client Example ===");

  const client = createClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (success, exitCode, stdout, stderr, command) => {
      console.log(
        `Command completed: ${command}, success=${success}, exitCode=${exitCode}`
      );
      if (stderr) console.log(`Stderr: ${stderr}`);
    },
    onCommandStart: (command) => {
      console.log(`Starting command: ${command}`);
    },
    onError: (error, command) => {
      console.error(`Error in ${command}: ${error}`);
    },
    onOutput: (stream, data, command) => {
      console.log(`[${stream}] ${data}`);
    },
  });

  try {
    // Create a session
    const sessionId = await client.createSession();
    console.log(`Created session: ${sessionId}`);

    // Execute some commands
    const lsResult = await client.execute("ls", ["-la"]);
    console.log("LS result:", lsResult.stdout);

    const pwdResult = await client.ping();
    console.log("Ping result:", pwdResult);

    const commands = await client.getCommands();
    console.log("Available commands:", commands.slice(0, 5));

    // List sessions
    const sessions = await client.listSessions();
    console.log(`Active sessions: ${sessions.count}`);
  } catch (error) {
    console.error("Operation failed:", error);
  } finally {
    client.clearSession();
  }
}

// Example 2: Streaming command execution
async function streamingExample() {
  console.log("\n=== Streaming Command Example ===");

  const client = createClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (success, exitCode, stdout, stderr, command) => {
      console.log(
        `\n✅ Completed: ${command}, success=${success}, exitCode=${exitCode}`
      );
    },
    onCommandStart: (command) => {
      console.log(`🚀 Starting: ${command}`);
    },
    onOutput: (stream, data, command) => {
      process.stdout.write(data);
    },
    onError: (error, command) => {
      console.error(`❌ Error in ${command}: ${error}`);
    },
  });

  try {
    await client.createSession();

    // Execute a long-running command with streaming
    console.log("Executing 'find . -name '*.ts' -type f' with streaming...");
    await client.executeStream("find", [".", "-name", "*.ts", "-type", "f"]);

    console.log("\nExecuting 'ls -la' with streaming...");
    await client.executeStream("ls", ["-la"]);
  } catch (error) {
    console.error("Streaming failed:", error);
  } finally {
    client.clearSession();
  }
}

// Example 3: Git operations
async function gitExample() {
  console.log("\n=== Git Operations Example ===");

  const client = createClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (success, exitCode, stdout, stderr, command) => {
      console.log(`✅ Git operation completed: ${command}, success=${success}`);
    },
    onCommandStart: (command) => {
      console.log(`🔧 Starting: ${command}`);
    },
    onOutput: (stream, data, command) => {
      console.log(`[${stream}] ${data.trim()}`);
    },
  });

  try {
    await client.createSession();

    // Create a directory for the repository
    console.log("Creating directory for repository...");
    const mkdirResult = await client.mkdir("test-repo", true);
    console.log(`Directory created: ${mkdirResult.success}`);

    // Checkout a small test repository
    console.log("Checking out a test repository...");
    const gitResult = await client.gitCheckout(
      "https://github.com/octocat/Hello-World.git",
      "main",
      "test-repo/hello-world"
    );
    console.log(
      `Repository cloned: ${gitResult.success}, target: ${gitResult.targetDir}`
    );

    // List the contents of the cloned repository
    console.log("Listing repository contents...");
    const lsResult = await client.execute("ls", [
      "-la",
      "test-repo/hello-world",
    ]);
    console.log("Repository contents:", lsResult.stdout);
  } catch (error) {
    console.error("Git operations failed:", error);
  } finally {
    client.clearSession();
  }
}

// Example 4: Streaming git operations
async function streamingGitExample() {
  console.log("\n=== Streaming Git Operations Example ===");

  const client = createClient({
    baseUrl: "http://localhost:3000",
    onCommandComplete: (success, exitCode, stdout, stderr, command) => {
      console.log(
        `\n🎉 Git operation completed: ${command}, success=${success}`
      );
    },
    onCommandStart: (command) => {
      console.log(`🌐 Starting git operation: ${command}`);
    },
    onOutput: (stream, data, command) => {
      if (stream === "stderr") {
        process.stderr.write(data);
      } else {
        process.stdout.write(data);
      }
    },
  });

  try {
    await client.createSession();

    // Create directory with streaming
    console.log("Creating directory with streaming...");
    await client.mkdirStream("streaming-test", true);

    // Checkout repository with streaming (real-time progress)
    console.log("Checking out repository with streaming...");
    await client.gitCheckoutStream(
      "https://github.com/octocat/Hello-World.git",
      "main",
      "streaming-test/hello-world"
    );
  } catch (error) {
    console.error("Streaming git operations failed:", error);
  } finally {
    client.clearSession();
  }
}

// Example 5: Quick execute utilities
async function quickExecuteExample() {
  console.log("\n=== Quick Execute Utilities Example ===");

  try {
    // Quick command execution
    console.log("Quick command execution...");
    const dateResult = await quickExecute("date");
    console.log("Date:", dateResult.stdout.trim());

    const whoamiResult = await quickExecute("whoami");
    console.log("User:", whoamiResult.stdout.trim());

    // Quick directory creation
    console.log("Quick directory creation...");
    const mkdirResult = await quickMkdir("quick-test", true);
    console.log(`Directory created: ${mkdirResult.success}`);

    // Quick git checkout
    console.log("Quick git checkout...");
    const gitResult = await quickGitCheckout(
      "https://github.com/octocat/Hello-World.git",
      "main",
      "quick-test/repo"
    );
    console.log(`Repository cloned: ${gitResult.success}`);

    // Quick streaming execution
    console.log("Quick streaming execution...");
    await quickExecuteStream("ls -la quick-test");
  } catch (error) {
    console.error("Quick execute failed:", error);
  }
}

// Example 6: Error handling
async function errorHandlingExample() {
  console.log("\n=== Error Handling Example ===");

  const client = createClient({
    baseUrl: "http://localhost:3000",
    onError: (error, command) => {
      console.error(`❌ Error in ${command}: ${error}`);
    },
  });

  try {
    await client.createSession();

    // Try to execute a non-existent command
    console.log("Trying to execute non-existent command...");
    try {
      await client.execute("nonexistentcommand");
    } catch (error) {
      console.log(
        "Expected error caught:",
        error instanceof Error ? error.message : error
      );
    }

    // Try to create a directory in a protected location
    console.log("Trying to create directory in protected location...");
    try {
      await client.mkdir("/etc/test", false);
    } catch (error) {
      console.log(
        "Expected error caught:",
        error instanceof Error ? error.message : error
      );
    }

    // Try to checkout an invalid repository
    console.log("Trying to checkout invalid repository...");
    try {
      await client.gitCheckout("invalid-url");
    } catch (error) {
      console.log(
        "Expected error caught:",
        error instanceof Error ? error.message : error
      );
    }
  } catch (error) {
    console.error("Error handling example failed:", error);
  } finally {
    client.clearSession();
  }
}

// Run examples
async function runExamples() {
  console.log("🚀 HTTP Client Examples\n");

  try {
    await basicExample();
    await streamingExample();
    await gitExample();
    await streamingGitExample();
    await quickExecuteExample();
    await errorHandlingExample();

    console.log("\n✅ All examples completed!");
  } catch (error) {
    console.error("❌ Example failed:", error);
  }
}

// Export for use in other modules
export {
  createClient,
  quickExecute,
  quickExecuteStream,
  quickGitCheckout,
  quickMkdir,
  quickGitCheckoutStream,
  quickMkdirStream,
};

// Run examples if this file is executed directly
if (require.main === module) {
  runExamples();
}
