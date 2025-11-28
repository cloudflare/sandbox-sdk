import * as acorn from 'acorn';

/**
 * Transforms JavaScript code to support top-level await and return the last expression's value.
 *
 * The transformation wraps code in an async IIFE:
 * - If the last statement is an expression, it's returned
 * - If the last statement is a declaration/control flow, undefined is returned
 *
 * Examples:
 *   "42"                    → "(async () => {\nreturn 42;\n})()"
 *   "const x = 5"           → "(async () => {\nconst x = 5\n})()"
 *   "const x = 5; x * 2"    → "(async () => {\nconst x = 5; return x * 2;\n})()"
 *   "await Promise.resolve()" → "(async () => {\nreturn await Promise.resolve();\n})()"
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

    // Check if last statement is an ExpressionStatement (evaluates to a value)
    if (lastNode.type === 'ExpressionStatement') {
      const beforeLast = trimmed.slice(0, lastNode.start);
      const lastExpr = trimmed.slice(lastNode.start, lastNode.end);
      // Remove trailing semicolon for clean return statement
      const cleanedExpr = lastExpr.replace(/;$/, '');

      return `(async () => {\n${beforeLast}return ${cleanedExpr};\n})()`;
    }

    // Last statement is a declaration, control flow, etc. - no return value
    return `(async () => {\n${trimmed}\n})()`;
  } catch {
    // Parse error - wrap as-is and let vm.runInContext surface the error
    // with proper line numbers and context
    return `(async () => {\n${trimmed}\n})()`;
  }
}
