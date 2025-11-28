import * as acorn from 'acorn';

/**
 * Transforms code to support top-level await by wrapping it in an async IIFE.
 * Returns the last expression's value if the final statement is an expression.
 */
export function transformForAsyncExecution(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return '(async () => {})()';
  }

  try {
    const ast = acorn.parse(trimmed, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true
    });

    const body = ast.body;
    if (body.length === 0) {
      return '(async () => {})()';
    }

    const lastNode = body[body.length - 1];

    // If the last statement is an ExpressionStatement, return its value
    if (lastNode.type === 'ExpressionStatement') {
      const beforeLast = trimmed.slice(0, lastNode.start);
      const lastExpr = trimmed.slice(lastNode.start, lastNode.end);
      // Remove trailing semicolon if present
      const cleanedExpr = lastExpr.replace(/;$/, '');
      return `(async () => {\n${beforeLast}return ${cleanedExpr};\n})()`;
    }

    // For other statement types (declarations, loops, etc.), just wrap
    return `(async () => {\n${trimmed}\n})()`;
  } catch {
    // If parsing fails, wrap anyway and let runtime report the error
    return `(async () => {\n${trimmed}\n})()`;
  }
}
