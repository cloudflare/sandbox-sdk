import { describe, expect, it } from 'bun:test';
import { transformForAsyncExecution } from '../../src/runtime/executors/shared/code-transformer';

describe('transformForAsyncExecution', () => {
  describe('empty code handling', () => {
    it('handles empty string', () => {
      const result = transformForAsyncExecution('');
      expect(result).toBe('(async () => {})()');
    });

    it('handles whitespace-only string', () => {
      const result = transformForAsyncExecution('   \n\t  ');
      expect(result).toBe('(async () => {})()');
    });
  });

  describe('expression statements', () => {
    it('returns last expression value for simple expression', () => {
      const result = transformForAsyncExecution('42');
      expect(result).toBe('(async () => {\nreturn 42;\n})()');
    });

    it('returns last expression value for string literal', () => {
      const result = transformForAsyncExecution('"hello"');
      expect(result).toBe('(async () => {\nreturn "hello";\n})()');
    });

    it('returns last expression value after declarations', () => {
      const result = transformForAsyncExecution('const x = 1;\nx + 1');
      expect(result).toBe('(async () => {\nconst x = 1;\nreturn x + 1;\n})()');
    });

    it('removes trailing semicolon from returned expression', () => {
      const result = transformForAsyncExecution('const x = 1;\nx + 1;');
      expect(result).toBe('(async () => {\nconst x = 1;\nreturn x + 1;\n})()');
    });

    it('returns function call result', () => {
      const result = transformForAsyncExecution('Math.max(1, 2)');
      expect(result).toBe('(async () => {\nreturn Math.max(1, 2);\n})()');
    });
  });

  describe('declaration statements', () => {
    it('wraps variable declaration without return', () => {
      const result = transformForAsyncExecution('const x = 1;');
      expect(result).toBe('(async () => {\nconst x = 1;\n})()');
    });

    it('wraps function declaration without return', () => {
      const result = transformForAsyncExecution('function foo() { return 1; }');
      expect(result).toBe('(async () => {\nfunction foo() { return 1; }\n})()');
    });

    it('wraps class declaration without return', () => {
      const result = transformForAsyncExecution('class Foo {}');
      expect(result).toBe('(async () => {\nclass Foo {}\n})()');
    });
  });

  describe('await expressions', () => {
    it('supports top-level await', () => {
      const result = transformForAsyncExecution('await Promise.resolve(42)');
      expect(result).toBe(
        '(async () => {\nreturn await Promise.resolve(42);\n})()'
      );
    });

    it('supports await followed by expression', () => {
      const result = transformForAsyncExecution('await delay(100);\n"done"');
      expect(result).toBe(
        '(async () => {\nawait delay(100);\nreturn "done";\n})()'
      );
    });

    it('supports await in variable assignment', () => {
      const result = transformForAsyncExecution(
        'const result = await fetch("/api");\nresult'
      );
      expect(result).toBe(
        '(async () => {\nconst result = await fetch("/api");\nreturn result;\n})()'
      );
    });

    it('supports multiple await expressions', () => {
      const result = transformForAsyncExecution(
        'const a = await foo();\nconst b = await bar();\na + b'
      );
      expect(result).toBe(
        '(async () => {\nconst a = await foo();\nconst b = await bar();\nreturn a + b;\n})()'
      );
    });
  });

  describe('complex statements', () => {
    it('wraps if statement without return', () => {
      const result = transformForAsyncExecution(
        'if (true) { console.log("yes"); }'
      );
      expect(result).toBe(
        '(async () => {\nif (true) { console.log("yes"); }\n})()'
      );
    });

    it('wraps for loop without return', () => {
      const result = transformForAsyncExecution(
        'for (let i = 0; i < 3; i++) {}'
      );
      expect(result).toBe(
        '(async () => {\nfor (let i = 0; i < 3; i++) {}\n})()'
      );
    });

    it('handles multiline code with final expression', () => {
      const code = `
const x = 1;
const y = 2;
x + y
      `.trim();
      const result = transformForAsyncExecution(code);
      expect(result).toContain('return x + y;');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('const y = 2;');
    });
  });

  describe('error handling', () => {
    it('wraps invalid syntax and lets runtime report error', () => {
      // Invalid JavaScript syntax
      const result = transformForAsyncExecution('const x = {');
      expect(result).toBe('(async () => {\nconst x = {\n})()');
    });
  });

  describe('real-world LLM code patterns', () => {
    it('handles typical LLM-generated fetch pattern', () => {
      const code = `
const response = await fetch('https://api.example.com/data');
const data = await response.json();
data
      `.trim();
      const result = transformForAsyncExecution(code);
      expect(result).toContain('return data;');
      expect(result).toStartWith('(async () => {');
      expect(result).toEndWith('})()');
    });

    it('handles async/await with error handling', () => {
      const code = `
try {
  const result = await doSomething();
  console.log(result);
} catch (e) {
  console.error(e);
}
      `.trim();
      const result = transformForAsyncExecution(code);
      // try/catch is a statement, not expression - no return
      expect(result).toBe(`(async () => {\n${code}\n})()`);
    });
  });
});
