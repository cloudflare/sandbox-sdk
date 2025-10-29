// Shared example definitions used by both frontend and backend
// Each example showcases a specific output type or capability
export const codeExamples = {
  "stdout-stderr": {
    name: "stdout-stderr",
    title: "Text Output (stdout/stderr)",
    description: "Basic print statements and error output",
    endpoint: "/api/examples/stdout-stderr",
    language: "python" as const,
    code: `print("This is standard output (stdout)")
print("You'll see this in the regular output")
print("=" * 40)

import sys
print("\\nThis is an error message", file=sys.stderr)
print("stderr is typically shown in red/different color", file=sys.stderr)

# Also demonstrate return value as text
"This is the return value (last expression)"`
  },

  "html-table": {
    name: "html-table",
    title: "HTML Table (Pandas)",
    description: "Rich HTML tables with pandas DataFrames",
    endpoint: "/api/examples/html-table",
    language: "python" as const,
    code: `import pandas as pd
import numpy as np

# Create a sample dataset with various data types
np.random.seed(42)
data = {
    'City': ['New York', 'Los Angeles', 'Chicago', 'Houston', 'Phoenix'],
    'Population (M)': [8.3, 4.0, 2.7, 2.3, 1.6],
    'Growth Rate (%)': [0.2, 1.5, -0.1, 2.3, 3.2],
    'Median Income': [75123, 69695, 63327, 52338, 61240],
    'Status': ['🟢 Stable', '🟢 Growing', '🔴 Declining', '🟢 Growing', '🟢 Growing']
}

df = pd.DataFrame(data)
df.index.name = 'Rank'

# Display the DataFrame directly - IPython will render it as HTML automatically
# The to_html() method or direct display both work without needing jinja2
print("City Statistics Table:")
df`
  },

  "chart-png": {
    name: "chart-png",
    title: "PNG Chart (Matplotlib)",
    description: "Generate PNG images with matplotlib",
    endpoint: "/api/examples/chart-png",
    language: "python" as const,
    code: `import matplotlib.pyplot as plt
import numpy as np

# Create an interesting visualization
fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(12, 5))

# Left plot: Animated-looking wave
x = np.linspace(0, 4*np.pi, 100)
y1 = np.sin(x)
y2 = np.sin(x + np.pi/4)
y3 = np.sin(x + np.pi/2)

ax1.plot(x, y1, 'b-', alpha=0.8, linewidth=2, label='Wave 1')
ax1.plot(x, y2, 'r-', alpha=0.8, linewidth=2, label='Wave 2')
ax1.plot(x, y3, 'g-', alpha=0.8, linewidth=2, label='Wave 3')
ax1.fill_between(x, 0, y1, alpha=0.3)
ax1.set_title('Interference Pattern')
ax1.set_xlabel('Position')
ax1.set_ylabel('Amplitude')
ax1.legend()
ax1.grid(True, alpha=0.3)

# Right plot: Statistical distribution
data = np.random.normal(100, 15, 1000)
ax2.hist(data, bins=30, color='purple', alpha=0.7, edgecolor='black')
ax2.axvline(data.mean(), color='red', linestyle='dashed', linewidth=2, label=f'Mean: {data.mean():.1f}')
ax2.axvline(data.mean() + data.std(), color='orange', linestyle='dashed', linewidth=1, label=f'Std: ±{data.std():.1f}')
ax2.axvline(data.mean() - data.std(), color='orange', linestyle='dashed', linewidth=1)
ax2.set_title('Normal Distribution')
ax2.set_xlabel('Value')
ax2.set_ylabel('Frequency')
ax2.legend()

plt.tight_layout()
plt.show()

print("Generated a dual-panel PNG chart")`
  },

  "json-data": {
    name: "json-data",
    title: "JSON Structured Data",
    description: "Return structured JSON data",
    endpoint: "/api/examples/json-data",
    language: "python" as const,
    code: `from datetime import datetime
import json

# Create complex nested data structure
analysis_result = {
    "timestamp": datetime.now().isoformat(),
    "summary": {
        "total_records": 1500,
        "processed": 1487,
        "errors": 13,
        "success_rate": 99.13
    },
    "categories": {
        "high_priority": 234,
        "medium_priority": 856,
        "low_priority": 397
    },
    "trends": [
        {"month": "Jan", "value": 120, "change": 5.2},
        {"month": "Feb", "value": 135, "change": 12.5},
        {"month": "Mar", "value": 128, "change": -5.2}
    ],
    "metadata": {
        "version": "2.0",
        "processor": "Python 3.x",
        "confidence": 0.95
    }
}

# IPython will automatically format dicts/lists as JSON
analysis_result`
  },

  "latex-math": {
    name: "latex-math",
    title: "LaTeX Mathematical Formulas",
    description: "Display mathematical equations using LaTeX",
    endpoint: "/api/examples/latex-math",
    language: "python" as const,
    code: `from IPython.display import Latex, display

print("Mathematical Formulas in LaTeX:\\n")

# Display various mathematical formulas
formulas = [
    ("Quadratic Formula", r"$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$"),
    ("Euler's Identity", r"$e^{i\\pi} + 1 = 0$"),
    ("Einstein's Mass-Energy", r"$E = mc^2$"),
    ("Gaussian Integral", r"$\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}$"),
    ("Binomial Theorem", r"$(x + y)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^{n-k} y^k$")
]

for name, formula in formulas:
    display(Latex(f"{name}: {formula}"))
    
# Matrix example
display(Latex(r"""
Matrix Multiplication:
$$\\begin{bmatrix}
1 & 2 \\\\
3 & 4
\\end{bmatrix}
\\times
\\begin{bmatrix}
5 & 6 \\\\
7 & 8
\\end{bmatrix}
=
\\begin{bmatrix}
19 & 22 \\\\
43 & 50
\\end{bmatrix}$$
"""))`
  },

  "markdown-rich": {
    name: "markdown-rich",
    title: "Markdown Formatted Text",
    description: "Rich text formatting with Markdown",
    endpoint: "/api/examples/markdown-rich",
    language: "python" as const,
    code: `from IPython.display import Markdown, display

markdown_doc = """
# 📊 Data Analysis Report

## Executive Summary
This report demonstrates **Markdown rendering** with various formatting capabilities.

## Key Findings

### Performance Metrics
- **Response Time**: 145ms _(15% improvement)_
- **Throughput**: 1,250 req/s
- **Error Rate**: 0.02%

### Status Indicators
| Component | Status | Health |
|-----------|--------|--------|
| API Server | ✅ Active | 100% |
| Database | ✅ Active | 98% |
| Cache | ⚠️ Degraded | 75% |
| Queue | ❌ Down | 0% |

## Code Sample
\`\`\`python
def analyze_performance(data):
    return {
        'mean': data.mean(),
        'std': data.std(),
        'p95': data.quantile(0.95)
    }
\`\`\`

## Recommendations
1. **Immediate Actions**
   - Restart queue service
   - Investigate cache degradation
   
2. **Long-term Improvements**
   - Implement redundancy
   - Upgrade infrastructure

---
*Generated with IPython Markdown support*
"""

display(Markdown(markdown_doc))`
  },

  "multiple-outputs": {
    name: "multiple-outputs",
    title: "Multiple Output Types",
    description: "Combine text, data, and visualization in one execution",
    endpoint: "/api/examples/multiple-outputs",
    language: "python" as const,
    code: `import pandas as pd
import matplotlib.pyplot as plt
import numpy as np
from IPython.display import display, Markdown

print("=== Multi-Output Example ===\\n")

# 1. Text output
print("Step 1: Generating data...")

# 2. Create and display a DataFrame (HTML table)
np.random.seed(42)
df = pd.DataFrame({
    'Metric': ['Accuracy', 'Precision', 'Recall', 'F1-Score'],
    'Model A': [0.92, 0.89, 0.94, 0.91],
    'Model B': [0.88, 0.91, 0.85, 0.88],
    'Model C': [0.95, 0.93, 0.96, 0.94]
})

print("\\nStep 2: Model Comparison Table")
display(df)  # Display DataFrame directly without styling

# 3. Create a visualization (PNG)
print("\\nStep 3: Generating visualization...")
fig, ax = plt.subplots(figsize=(10, 6))
x = np.arange(len(df['Metric']))
width = 0.25

ax.bar(x - width, df['Model A'], width, label='Model A', color='skyblue')
ax.bar(x, df['Model B'], width, label='Model B', color='orange')
ax.bar(x + width, df['Model C'], width, label='Model C', color='lightgreen')

ax.set_xlabel('Metrics')
ax.set_ylabel('Score')
ax.set_title('Model Performance Comparison')
ax.set_xticks(x)
ax.set_xticklabels(df['Metric'])
ax.legend()
ax.grid(True, alpha=0.3)
plt.tight_layout()
plt.show()

# 4. Return JSON data
summary = {
    "best_model": "Model C",
    "best_metric": "Recall",
    "average_scores": {
        "Model A": float(df['Model A'].mean()),
        "Model B": float(df['Model B'].mean()),
        "Model C": float(df['Model C'].mean())
    }
}

# Return the summary as final result
summary`
  },

  "javascript-example": {
    name: "javascript-example",
    title: "JavaScript Execution",
    description: "Execute JavaScript/Node.js code",
    endpoint: "/api/examples/javascript-example",
    language: "javascript" as const,
    code: `console.log("Hello from JavaScript!");
console.log("Node version:", process.version);

// Create some structured data
const analysis = {
  timestamp: new Date().toISOString(),
  environment: {
    platform: process.platform,
    nodeVersion: process.version,
    memory: process.memoryUsage()
  },
  calculations: {
    fibonacci: [1, 1, 2, 3, 5, 8, 13, 21],
    primes: [2, 3, 5, 7, 11, 13, 17, 19]
  }
};

console.log("\\nAnalysis Result:");
console.log(JSON.stringify(analysis, null, 2));

// Return structured data
analysis`
  },

  "typescript-example": {
    name: "typescript-example",
    title: "TypeScript Execution",
    description: "Execute TypeScript code with type annotations",
    endpoint: "/api/examples/typescript-example",
    language: "typescript" as const,
    code: `// TypeScript with full type support
interface User {
  id: number;
  name: string;
  email: string;
  roles: string[];
  createdAt: Date;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  metadata: {
    timestamp: string;
    version: string;
    requestId: string;
  };
}

class UserService {
  private users: User[] = [];
  
  constructor() {
    console.log("UserService initialized");
  }
  
  addUser(user: Omit<User, 'id' | 'createdAt'>): User {
    const newUser: User = {
      ...user,
      id: this.users.length + 1,
      createdAt: new Date()
    };
    this.users.push(newUser);
    return newUser;
  }
  
  findUsersByRole(role: string): User[] {
    return this.users.filter(user => user.roles.includes(role));
  }
  
  getStatistics(): Record<string, any> {
    return {
      totalUsers: this.users.length,
      roleDistribution: this.getRoleDistribution(),
      averageRolesPerUser: this.getAverageRoles()
    };
  }
  
  private getRoleDistribution(): Record<string, number> {
    const distribution: Record<string, number> = {};
    this.users.forEach(user => {
      user.roles.forEach(role => {
        distribution[role] = (distribution[role] || 0) + 1;
      });
    });
    return distribution;
  }
  
  private getAverageRoles(): number {
    if (this.users.length === 0) return 0;
    const totalRoles = this.users.reduce((sum, user) => sum + user.roles.length, 0);
    return totalRoles / this.users.length;
  }
}

// Create service and add some users
const service = new UserService();

const users: Omit<User, 'id' | 'createdAt'>[] = [
  { name: "Alice Johnson", email: "alice@example.com", roles: ["admin", "developer"] },
  { name: "Bob Smith", email: "bob@example.com", roles: ["user"] },
  { name: "Charlie Brown", email: "charlie@example.com", roles: ["developer", "tester"] },
  { name: "Diana Prince", email: "diana@example.com", roles: ["admin", "user"] }
];

console.log("Adding users to the system...");
users.forEach(userData => {
  const user = service.addUser(userData);
  console.log(\`Added user: \${user.name} (ID: \${user.id})\`);
});

console.log("\\nFinding all developers:");
const developers = service.findUsersByRole("developer");
developers.forEach(dev => console.log(\`  - \${dev.name}\`));

console.log("\\nUser Statistics:");
const stats = service.getStatistics();
console.log(JSON.stringify(stats, null, 2));

// Create API response with generics
const apiResponse: ApiResponse<typeof stats> = {
  success: true,
  data: stats,
  metadata: {
    timestamp: new Date().toISOString(),
    version: "1.0.0",
    requestId: Math.random().toString(36).substring(7)
  }
};

console.log("\\nAPI Response:");
console.log(JSON.stringify(apiResponse, null, 2));

// Return the response for display
apiResponse`
  },

  "error-handling": {
    name: "error-handling",
    title: "Error Handling Demo",
    description: "Show how errors and tracebacks are captured",
    endpoint: "/api/examples/error-handling",
    language: "python" as const,
    code: `def divide_numbers(a, b):
    """Function that might raise an error"""
    if b == 0:
        raise ValueError("Cannot divide by zero!")
    return a / b

def process_data(values):
    """Process a list of values"""
    results = []
    for i, val in enumerate(values):
        result = divide_numbers(100, val)
        results.append(result)
        print(f"Processed item {i}: {result}")
    return results

print("Testing error handling...")
print("Processing valid values:")
process_data([10, 20, 5])

print("\\nNow attempting invalid operation:")
# This will raise an error with a full traceback
process_data([10, 20, 0, 5])  # Zero will cause division error`
  }
};

export type ExampleName = keyof typeof codeExamples;
export type CodeExample = typeof codeExamples[ExampleName];