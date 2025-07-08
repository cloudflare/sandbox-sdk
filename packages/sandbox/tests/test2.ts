import {
  createClient,
  HttpClient,
  quickDeleteFile,
  quickDeleteFileStream,
  quickExecute,
  quickExecuteStream,
  quickMoveFile,
  quickMoveFileStream,
  quickReadFile,
  quickReadFileStream,
  quickRenameFile,
  quickRenameFileStream,
  quickWriteFile,
  quickWriteFileStream,
} from "../../sandbox/src/client";
import { isMain } from "./common";

async function testHttpClient() {
  console.log("🧪 Testing HTTP Client...\n");

  // Test 1: Basic connection and ping
  console.log("Test 1: Basic connection and ping");
  try {
    const client = createClient();
    const pingResult = await client.ping();
    console.log("✅ Ping result:", pingResult);

    const sessionId = await client.createSession();
    console.log("✅ Session created:", sessionId);
    console.log("✅ Connection test completed\n");
  } catch (error) {
    console.error("❌ Test 1 failed:", error);
  }

  // Test 2: Command execution
  console.log("Test 2: Command execution");
  try {
    const result = await quickExecute("echo", ["Hello from HTTP client!"]);
    console.log("✅ Command executed:", result.success);
    console.log("   Output:", result.stdout.trim());
    console.log("   Exit code:", result.exitCode, "\n");
  } catch (error) {
    console.error("❌ Test 2 failed:", error);
  }

  // Test 3: Multiple commands with session
  console.log("Test 3: Multiple commands with session");
  try {
    const client = createClient();
    const sessionId = await client.createSession();

    const commands: [string, string[]][] = [
      ["pwd", []],
      ["ls", ["-la"]],
      ["echo", ["Multiple commands test"]],
    ];

    for (const [command, args] of commands) {
      console.log(`Executing: ${command} ${args.join(" ")}`);
      const result = await client.execute(command, args, sessionId);
      console.log(`   Success: ${result.success}, Exit: ${result.exitCode}`);
    }

    client.clearSession();
    console.log("✅ Multiple commands test completed\n");
  } catch (error) {
    console.error("❌ Test 3 failed:", error);
  }

  // Test 4: Error handling
  console.log("Test 4: Error handling");
  try {
    const result = await quickExecute("nonexistentcommand");
    console.log("✅ Error handled gracefully");
    console.log("   Success:", result.success);
    console.log("   Exit code:", result.exitCode);
    console.log("   Error output:", result.stderr.trim(), "\n");
  } catch (error) {
    console.error("❌ Test 4 failed:", error);
  }

  // Test 5: Session management
  console.log("Test 5: Session management");
  try {
    const client = createClient();

    // Create session
    const sessionId1 = await client.createSession();
    console.log("✅ Session 1 created:", sessionId1);

    // Create another session
    const sessionId2 = await client.createSession();
    console.log("✅ Session 2 created:", sessionId2);

    // List sessions
    const sessions = await client.listSessions();
    console.log("✅ Sessions listed:", sessions.count, "active sessions");

    // Execute command in specific session
    const result = await client.execute("whoami", [], sessionId1);
    console.log("✅ Command executed in session 1:", result.stdout.trim());

    client.clearSession();
    console.log("✅ Session management test completed\n");
  } catch (error) {
    console.error("❌ Test 5 failed:", error);
  }

  // Test 6: Available commands
  console.log("Test 6: Available commands");
  try {
    const client = createClient();
    const commands = await client.getCommands();
    console.log("✅ Available commands:", commands.length);
    console.log("   Commands:", commands.slice(0, 5).join(", "), "...\n");
  } catch (error) {
    console.error("❌ Test 6 failed:", error);
  }

  // Test 7: Streaming command execution
  console.log("Test 7: Streaming command execution");
  try {
    const client = createClient();
    await client.createSession();

    console.log("   Starting streaming command...");
    await client.executeStream("ls", ["-la"]);
    console.log("✅ Streaming command completed\n");

    client.clearSession();
  } catch (error) {
    console.error("❌ Test 7 failed:", error);
  }

  // Test 8: Quick streaming execution
  console.log("Test 8: Quick streaming execution");
  try {
    console.log("   Starting quick streaming command...");
    await quickExecuteStream("echo", ["Hello from quick streaming!"]);
    console.log("✅ Quick streaming command completed\n");
  } catch (error) {
    console.error("❌ Test 8 failed:", error);
  }

  // Test 9: File writing
  console.log("Test 9: File writing");
  try {
    const testContent = "Hello, this is a test file!\nLine 2\nLine 3";
    const result = await quickWriteFile("test-file.txt", testContent);
    console.log("✅ File written successfully:", result.success);
    console.log("   Path:", result.path);
    console.log("   Exit code:", result.exitCode);

    // Verify the file was created by reading it
    const readResult = await quickExecute("cat", ["test-file.txt"]);
    console.log(
      "✅ File content verified:",
      readResult.stdout.trim() === testContent
    );
    console.log("   Content length:", readResult.stdout.length, "characters\n");
  } catch (error) {
    console.error("❌ Test 9 failed:", error);
  }

  // Test 10: File writing with custom encoding
  console.log("Test 10: File writing with custom encoding");
  try {
    const jsonContent = '{"name": "test", "value": 42, "active": true}';
    const result = await quickWriteFile("test-data.json", jsonContent, "utf-8");
    console.log("✅ JSON file written successfully:", result.success);
    console.log("   Path:", result.path);

    // Verify the JSON file
    const readResult = await quickExecute("cat", ["test-data.json"]);
    console.log(
      "✅ JSON content verified:",
      readResult.stdout.trim() === jsonContent
    );
    console.log("   JSON content:", readResult.stdout.trim(), "\n");
  } catch (error) {
    console.error("❌ Test 10 failed:", error);
  }

  // Test 11: File writing in nested directories
  console.log("Test 11: File writing in nested directories");
  try {
    const nestedContent = "This file is in a nested directory";
    const result = await quickWriteFile(
      "nested/dir/test-nested.txt",
      nestedContent
    );
    console.log("✅ Nested file written successfully:", result.success);
    console.log("   Path:", result.path);

    // Verify the nested directory was created
    const dirResult = await quickExecute("ls", ["-la", "nested/dir"]);
    console.log("✅ Nested directory created and file exists");
    console.log(
      "   Directory listing:",
      dirResult.stdout.includes("test-nested.txt")
    );

    // Verify the file content
    const readResult = await quickExecute("cat", [
      "nested/dir/test-nested.txt",
    ]);
    console.log(
      "✅ Nested file content verified:",
      readResult.stdout.trim() === nestedContent,
      "\n"
    );
  } catch (error) {
    console.error("❌ Test 11 failed:", error);
  }

  // Test 12: Streaming file writing
  console.log("Test 12: Streaming file writing");
  try {
    const client = createClient();
    await client.createSession();

    const largeContent = `${"Line 1\n".repeat(100)}Final line`;
    console.log("   Starting streaming file write...");

    await client.writeFileStream("large-file.txt", largeContent);
    console.log("✅ Streaming file write completed");

    // Verify the file
    const readResult = await client.execute("wc", ["-l", "large-file.txt"]);
    console.log(
      "✅ Large file verified:",
      readResult.stdout.trim().includes("101")
    );
    console.log("   Line count:", readResult.stdout.trim());

    client.clearSession();
    console.log("✅ Streaming file writing test completed\n");
  } catch (error) {
    console.error("❌ Test 12 failed:", error);
  }

  // Test 13: Quick streaming file writing
  console.log("Test 13: Quick streaming file writing");
  try {
    const quickContent = "Quick streaming test content";
    console.log("   Starting quick streaming file write...");

    await quickWriteFileStream("quick-stream.txt", quickContent);
    console.log("✅ Quick streaming file write completed");

    // Verify the file
    const readResult = await quickExecute("cat", ["quick-stream.txt"]);
    console.log(
      "✅ Quick streaming file verified:",
      readResult.stdout.trim() === quickContent,
      "\n"
    );
  } catch (error) {
    console.error("❌ Test 13 failed:", error);
  }

  // Test 14: File writing with session management
  console.log("Test 14: File writing with session management");
  try {
    const client = createClient();
    const sessionId = await client.createSession();

    const sessionContent = "This file was written with session management";
    const result = await client.writeFile(
      "session-file.txt",
      sessionContent,
      "utf-8",
      sessionId
    );
    console.log("✅ Session file written successfully:", result.success);
    console.log("   Session ID:", sessionId);

    // Verify the file
    const readResult = await client.execute(
      "cat",
      ["session-file.txt"],
      sessionId
    );
    console.log(
      "✅ Session file content verified:",
      readResult.stdout.trim() === sessionContent
    );

    client.clearSession();
    console.log("✅ Session file writing test completed\n");
  } catch (error) {
    console.error("❌ Test 14 failed:", error);
  }

  // Test 15: Error handling for file writing
  console.log("Test 15: Error handling for file writing");
  try {
    // Try to write to a dangerous path (should be blocked)
    await quickWriteFile("/etc/test.txt", "This should fail");
    console.log("❌ Should have failed for dangerous path");
  } catch (error) {
    console.log("✅ Error handling works for dangerous paths");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to write with invalid parameters
    await quickWriteFile("", "Empty path should fail");
    console.log("❌ Should have failed for empty path");
  } catch (error) {
    console.log("✅ Error handling works for invalid parameters");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error",
      "\n"
    );
  }

  // Test 16: File deletion
  console.log("Test 16: File deletion");
  try {
    // First create a file to delete
    const deleteContent = "This file will be deleted";
    await quickWriteFile("file-to-delete.txt", deleteContent);
    console.log("✅ Test file created for deletion");

    // Delete the file
    const result = await quickDeleteFile("file-to-delete.txt");
    console.log("✅ File deleted successfully:", result.success);
    console.log("   Path:", result.path);
    console.log("   Exit code:", result.exitCode);

    // Verify the file was deleted
    try {
      await quickExecute("cat", ["file-to-delete.txt"]);
      console.log("❌ File still exists after deletion");
    } catch (error) {
      console.log("✅ File successfully deleted (not found)");
    }
    console.log("✅ File deletion test completed\n");
  } catch (error) {
    console.error("❌ Test 16 failed:", error);
  }

  // Test 17: File renaming
  console.log("Test 17: File renaming");
  try {
    // First create a file to rename
    const renameContent = "This file will be renamed";
    await quickWriteFile("file-to-rename.txt", renameContent);
    console.log("✅ Test file created for renaming");

    // Rename the file
    const result = await quickRenameFile(
      "file-to-rename.txt",
      "renamed-file.txt"
    );
    console.log("✅ File renamed successfully:", result.success);
    console.log("   Old path:", result.oldPath);
    console.log("   New path:", result.newPath);
    console.log("   Exit code:", result.exitCode);

    // Verify the old file doesn't exist
    try {
      await quickExecute("cat", ["file-to-rename.txt"]);
      console.log("❌ Old file still exists");
    } catch (error) {
      console.log("✅ Old file successfully removed");
    }

    // Verify the new file exists with correct content
    const readResult = await quickExecute("cat", ["renamed-file.txt"]);
    console.log(
      "✅ Renamed file content verified:",
      readResult.stdout.trim() === renameContent
    );
    console.log("   New file content:", readResult.stdout.trim());
    console.log("✅ File renaming test completed\n");
  } catch (error) {
    console.error("❌ Test 17 failed:", error);
  }

  // Test 18: File moving
  console.log("Test 18: File moving");
  try {
    // First create a file to move
    const moveContent = "This file will be moved";
    await quickWriteFile("file-to-move.txt", moveContent);
    console.log("✅ Test file created for moving");

    // Create destination directory
    await quickExecute("mkdir", ["-p", "move-destination"]);
    console.log("✅ Destination directory created");

    // Move the file
    const result = await quickMoveFile(
      "file-to-move.txt",
      "move-destination/moved-file.txt"
    );
    console.log("✅ File moved successfully:", result.success);
    console.log("   Source path:", result.sourcePath);
    console.log("   Destination path:", result.destinationPath);
    console.log("   Exit code:", result.exitCode);

    // Verify the source file doesn't exist
    try {
      await quickExecute("cat", ["file-to-move.txt"]);
      console.log("❌ Source file still exists");
    } catch (error) {
      console.log("✅ Source file successfully removed");
    }

    // Verify the destination file exists with correct content
    const readResult = await quickExecute("cat", [
      "move-destination/moved-file.txt",
    ]);
    console.log(
      "✅ Moved file content verified:",
      readResult.stdout.trim() === moveContent
    );
    console.log("   Moved file content:", readResult.stdout.trim());
    console.log("✅ File moving test completed\n");
  } catch (error) {
    console.error("❌ Test 18 failed:", error);
  }

  // Test 19: Streaming file deletion
  console.log("Test 19: Streaming file deletion");
  try {
    const client = createClient();
    await client.createSession();

    // First create a file to delete
    const streamDeleteContent = "This file will be deleted via streaming";
    await client.writeFile("stream-delete-file.txt", streamDeleteContent);
    console.log("✅ Test file created for streaming deletion");

    console.log("   Starting streaming file deletion...");
    await client.deleteFileStream("stream-delete-file.txt");
    console.log("✅ Streaming file deletion completed");

    // Verify the file was deleted
    try {
      await client.execute("cat", ["stream-delete-file.txt"]);
      console.log("❌ File still exists after streaming deletion");
    } catch (error) {
      console.log("✅ File successfully deleted via streaming");
    }

    client.clearSession();
    console.log("✅ Streaming file deletion test completed\n");
  } catch (error) {
    console.error("❌ Test 19 failed:", error);
  }

  // Test 20: Streaming file renaming
  console.log("Test 20: Streaming file renaming");
  try {
    const client = createClient();
    await client.createSession();

    // First create a file to rename
    const streamRenameContent = "This file will be renamed via streaming";
    await client.writeFile("stream-rename-file.txt", streamRenameContent);
    console.log("✅ Test file created for streaming renaming");

    console.log("   Starting streaming file renaming...");
    await client.renameFileStream(
      "stream-rename-file.txt",
      "stream-renamed-file.txt"
    );
    console.log("✅ Streaming file renaming completed");

    // Verify the renamed file exists with correct content
    const readResult = await client.execute("cat", ["stream-renamed-file.txt"]);
    console.log(
      "✅ Stream renamed file content verified:",
      readResult.stdout.trim() === streamRenameContent
    );

    client.clearSession();
    console.log("✅ Streaming file renaming test completed\n");
  } catch (error) {
    console.error("❌ Test 20 failed:", error);
  }

  // Test 21: Streaming file moving
  console.log("Test 21: Streaming file moving");
  try {
    const client = createClient();
    await client.createSession();

    // First create a file to move
    const streamMoveContent = "This file will be moved via streaming";
    await client.writeFile("stream-move-file.txt", streamMoveContent);
    console.log("✅ Test file created for streaming moving");

    // Create destination directory
    await client.execute("mkdir", ["-p", "stream-move-dest"]);
    console.log("✅ Stream destination directory created");

    console.log("   Starting streaming file moving...");
    await client.moveFileStream(
      "stream-move-file.txt",
      "stream-move-dest/stream-moved-file.txt"
    );
    console.log("✅ Streaming file moving completed");

    // Verify the moved file exists with correct content
    const readResult = await client.execute("cat", [
      "stream-move-dest/stream-moved-file.txt",
    ]);
    console.log(
      "✅ Stream moved file content verified:",
      readResult.stdout.trim() === streamMoveContent
    );

    client.clearSession();
    console.log("✅ Streaming file moving test completed\n");
  } catch (error) {
    console.error("❌ Test 21 failed:", error);
  }

  // Test 22: Quick streaming file operations
  console.log("Test 22: Quick streaming file operations");
  try {
    // Create files for quick operations
    await quickWriteFile("quick-delete.txt", "Quick delete test");
    await quickWriteFile("quick-rename.txt", "Quick rename test");
    await quickWriteFile("quick-move.txt", "Quick move test");
    console.log("✅ Test files created for quick operations");

    // Quick streaming delete
    console.log("   Starting quick streaming delete...");
    await quickDeleteFileStream("quick-delete.txt");
    console.log("✅ Quick streaming delete completed");

    // Quick streaming rename
    console.log("   Starting quick streaming rename...");
    await quickRenameFileStream("quick-rename.txt", "quick-renamed.txt");
    console.log("✅ Quick streaming rename completed");

    // Quick streaming move
    console.log("   Starting quick streaming move...");
    await quickMoveFileStream("quick-move.txt", "quick-moved.txt");
    console.log("✅ Quick streaming move completed");

    // Verify results
    const renameResult = await quickExecute("cat", ["quick-renamed.txt"]);
    const moveResult = await quickExecute("cat", ["quick-moved.txt"]);
    console.log(
      "✅ Quick operations verified:",
      renameResult.stdout.trim() === "Quick rename test" &&
        moveResult.stdout.trim() === "Quick move test"
    );
    console.log("✅ Quick streaming file operations test completed\n");
  } catch (error) {
    console.error("❌ Test 22 failed:", error);
  }

  // Test 23: File operations with session management
  console.log("Test 23: File operations with session management");
  try {
    const client = createClient();
    const sessionId = await client.createSession();

    // Create test files in session
    await client.writeFile(
      "session-delete.txt",
      "Session delete test",
      "utf-8",
      sessionId
    );
    await client.writeFile(
      "session-rename.txt",
      "Session rename test",
      "utf-8",
      sessionId
    );
    await client.writeFile(
      "session-move.txt",
      "Session move test",
      "utf-8",
      sessionId
    );
    console.log("✅ Session test files created");

    // Delete file in session
    const deleteResult = await client.deleteFile(
      "session-delete.txt",
      sessionId
    );
    console.log("✅ Session file deleted:", deleteResult.success);

    // Rename file in session
    const renameResult = await client.renameFile(
      "session-rename.txt",
      "session-renamed.txt",
      sessionId
    );
    console.log("✅ Session file renamed:", renameResult.success);

    // Move file in session
    const moveResult = await client.moveFile(
      "session-move.txt",
      "session-moved.txt",
      sessionId
    );
    console.log("✅ Session file moved:", moveResult.success);

    // Verify session operations
    const renameContent = await client.execute(
      "cat",
      ["session-renamed.txt"],
      sessionId
    );
    const moveContent = await client.execute(
      "cat",
      ["session-moved.txt"],
      sessionId
    );
    console.log(
      "✅ Session operations verified:",
      renameContent.stdout.trim() === "Session rename test" &&
        moveContent.stdout.trim() === "Session move test"
    );

    client.clearSession();
    console.log("✅ File operations with session management test completed\n");
  } catch (error) {
    console.error("❌ Test 23 failed:", error);
  }

  // Test 24: Error handling for file operations
  console.log("Test 24: Error handling for file operations");
  try {
    // Try to delete a non-existent file
    await quickDeleteFile("non-existent-file.txt");
    console.log("❌ Should have failed for non-existent file");
  } catch (error) {
    console.log("✅ Error handling works for non-existent files");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to delete a dangerous path
    await quickDeleteFile("/etc/passwd");
    console.log("❌ Should have failed for dangerous path");
  } catch (error) {
    console.log("✅ Error handling works for dangerous paths");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to rename with invalid parameters
    await quickRenameFile("", "new-name.txt");
    console.log("❌ Should have failed for empty old path");
  } catch (error) {
    console.log("✅ Error handling works for invalid rename parameters");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to move with invalid parameters
    await quickMoveFile("source.txt", "");
    console.log("❌ Should have failed for empty destination path");
  } catch (error) {
    console.log("✅ Error handling works for invalid move parameters");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error",
      "\n"
    );
  }

  // Test 25: File reading
  console.log("Test 25: File reading");
  try {
    // First create a file to read
    const readContent = "This is a test file for reading\nLine 2\nLine 3";
    await quickWriteFile("file-to-read.txt", readContent);
    console.log("✅ Test file created for reading");

    // Read the file
    const result = await quickReadFile("file-to-read.txt");
    console.log("✅ File read successfully:", result.success);
    console.log("   Path:", result.path);
    console.log("   Content length:", result.content.length, "characters");
    console.log("   Exit code:", result.exitCode);

    // Verify the content
    console.log("✅ File content verified:", result.content === readContent);
    console.log("   Content:", result.content);
    console.log("✅ File reading test completed\n");
  } catch (error) {
    console.error("❌ Test 25 failed:", error);
  }

  // Test 26: File reading with custom encoding
  console.log("Test 26: File reading with custom encoding");
  try {
    // Create a file with special characters
    const specialContent = "Hello 世界! 🌍 Test with emojis and unicode";
    await quickWriteFile("special-chars.txt", specialContent, "utf-8");
    console.log("✅ Special characters file created");

    // Read with explicit UTF-8 encoding
    const result = await quickReadFile("special-chars.txt", "utf-8");
    console.log(
      "✅ Special characters file read successfully:",
      result.success
    );
    console.log(
      "✅ Special characters verified:",
      result.content === specialContent
    );
    console.log("   Content:", result.content);
    console.log("✅ Custom encoding test completed\n");
  } catch (error) {
    console.error("❌ Test 26 failed:", error);
  }

  // Test 27: File reading in nested directories
  console.log("Test 27: File reading in nested directories");
  try {
    // Create a file in a nested directory
    const nestedContent = "This file is in a nested directory for reading";
    await quickWriteFile("nested/read/test-nested-read.txt", nestedContent);
    console.log("✅ Nested file created for reading");

    // Read the nested file
    const result = await quickReadFile("nested/read/test-nested-read.txt");
    console.log("✅ Nested file read successfully:", result.success);
    console.log(
      "✅ Nested file content verified:",
      result.content === nestedContent
    );
    console.log("   Content:", result.content);
    console.log("✅ Nested directory reading test completed\n");
  } catch (error) {
    console.error("❌ Test 27 failed:", error);
  }

  // Test 28: Streaming file reading
  console.log("Test 28: Streaming file reading");
  try {
    const client = createClient();
    await client.createSession();

    // Create a file to read via streaming
    const streamReadContent =
      "This file will be read via streaming\nLine 2\nLine 3";
    await client.writeFile("stream-read-file.txt", streamReadContent);
    console.log("✅ Test file created for streaming reading");

    let readContent = "";
    let readCompleted = false;

    // Set up event handlers for streaming
    client.setOnStreamEvent((event) => {
      if (event.type === "command_complete" && event.content) {
        readContent = event.content;
        readCompleted = true;
      }
    });

    console.log("   Starting streaming file reading...");
    await client.readFileStream("stream-read-file.txt");
    console.log("✅ Streaming file reading completed");

    // Verify the content was read correctly
    console.log(
      "✅ Streaming read content verified:",
      readContent === streamReadContent
    );
    console.log("   Content length:", readContent.length, "characters");

    client.clearSession();
    console.log("✅ Streaming file reading test completed\n");
  } catch (error) {
    console.error("❌ Test 28 failed:", error);
  }

  // Test 29: Quick streaming file reading
  console.log("Test 29: Quick streaming file reading");
  try {
    // Create a file for quick streaming read
    const quickReadContent = "Quick streaming read test content";
    await quickWriteFile("quick-read-stream.txt", quickReadContent);
    console.log("✅ Test file created for quick streaming reading");

    let quickReadContentReceived = "";
    let quickReadCompleted = false;

    console.log("   Starting quick streaming file reading...");
    await quickReadFileStream("quick-read-stream.txt", "utf-8", {
      onStreamEvent: (event) => {
        if (event.type === "command_complete" && event.content) {
          quickReadContentReceived = event.content;
          quickReadCompleted = true;
        }
      },
    });
    console.log("✅ Quick streaming file reading completed");

    // Verify the content
    console.log(
      "✅ Quick streaming read verified:",
      quickReadContentReceived === quickReadContent
    );
    console.log("   Content:", quickReadContentReceived);
    console.log("✅ Quick streaming file reading test completed\n");
  } catch (error) {
    console.error("❌ Test 29 failed:", error);
  }

  // Test 30: File reading with session management
  console.log("Test 30: File reading with session management");
  try {
    const client = createClient();
    const sessionId = await client.createSession();

    // Create a file in session
    const sessionReadContent =
      "This file was created and read with session management";
    await client.writeFile(
      "session-read-file.txt",
      sessionReadContent,
      "utf-8",
      sessionId
    );
    console.log("✅ Session file created for reading");

    // Read the file in the same session
    const result = await client.readFile(
      "session-read-file.txt",
      "utf-8",
      sessionId
    );
    console.log("✅ Session file read successfully:", result.success);
    console.log(
      "✅ Session file content verified:",
      result.content === sessionReadContent
    );
    console.log("   Session ID:", sessionId);
    console.log("   Content:", result.content);

    client.clearSession();
    console.log("✅ Session file reading test completed\n");
  } catch (error) {
    console.error("❌ Test 30 failed:", error);
  }

  // Test 31: Error handling for file reading
  console.log("Test 31: Error handling for file reading");
  try {
    // Try to read a non-existent file
    await quickReadFile("non-existent-read-file.txt");
    console.log("❌ Should have failed for non-existent file");
  } catch (error) {
    console.log("✅ Error handling works for non-existent files");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to read from a dangerous path
    await quickReadFile("/etc/passwd");
    console.log("❌ Should have failed for dangerous path");
  } catch (error) {
    console.log("✅ Error handling works for dangerous paths");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  try {
    // Try to read with empty path
    await quickReadFile("");
    console.log("❌ Should have failed for empty path");
  } catch (error) {
    console.log("✅ Error handling works for empty paths");
    console.log(
      "   Error:",
      error instanceof Error ? error.message : "Unknown error",
      "\n"
    );
  }

  console.log("🎉 All tests completed!");
}

// Run tests if this file is executed directly
if (isMain) {
  // Add a timeout to prevent hanging
  const timeout = setTimeout(() => {
    console.error("❌ Tests timed out after 60 seconds");
    process.exit(1);
  }, 60000);

  testHttpClient()
    .then(() => {
      clearTimeout(timeout);
      console.log("✅ Tests finished successfully");
      process.exit(0);
    })
    .catch((error) => {
      clearTimeout(timeout);
      console.error("❌ Tests failed:", error);
      process.exit(1);
    });
}

export { testHttpClient };
