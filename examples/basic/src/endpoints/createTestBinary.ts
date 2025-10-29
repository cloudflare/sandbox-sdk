import type { Sandbox } from '@cloudflare/sandbox';
import { errorResponse, jsonResponse } from '../http';

export async function createTestBinaryFile(sandbox: Sandbox<unknown>) {
  try {
    // Use code interpreter to create a test PNG chart
    const pythonCode = `
import matplotlib.pyplot as plt
import numpy as np

# Create a nice looking chart
fig, ax = plt.subplots(figsize=(10, 6))

# Generate sample data
x = np.linspace(0, 10, 100)
y1 = np.sin(x)
y2 = np.cos(x)
y3 = np.sin(x) * np.cos(x)

# Plot multiple lines
ax.plot(x, y1, 'b-', linewidth=2, label='sin(x)', alpha=0.8)
ax.plot(x, y2, 'r-', linewidth=2, label='cos(x)', alpha=0.8)
ax.plot(x, y3, 'g-', linewidth=2, label='sin(x)·cos(x)', alpha=0.8)

# Add styling
ax.set_title('Binary File Support Demo - Mathematical Functions', fontsize=16, fontweight='bold')
ax.set_xlabel('x', fontsize=12)
ax.set_ylabel('y', fontsize=12)
ax.legend(loc='upper right', fontsize=10)
ax.grid(True, alpha=0.3)
ax.set_facecolor('#f8f9fa')

# Save to file
plt.tight_layout()
plt.savefig('/workspace/demo-chart.png', dpi=100, bbox_inches='tight')
print("Chart saved to /workspace/demo-chart.png")
`;

    // Create a code context and execute the Python code
    const context = await sandbox.createCodeContext({ language: 'python' });
    const execution = await sandbox.runCode(pythonCode, { context });

    // Check for errors
    if (execution.error) {
      console.error('Error creating chart:', execution.error);
      return errorResponse(
        `Failed to create chart: ${execution.error.message}`
      );
    }

    // Return success with file path
    return jsonResponse({
      success: true,
      path: '/workspace/demo-chart.png',
      type: 'image/png',
      message: 'Test PNG chart created successfully',
      stdout: execution.logs.stdout.join('\n')
    });
  } catch (error: any) {
    console.error('Error creating test binary file:', error);
    return errorResponse(`Failed to create test binary file: ${error.message}`);
  }
}
