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
      expect(result).toBe('(async () => {\nreturn (42);\n})()');
    });

    it('returns last expression value for string literal', () => {
      const result = transformForAsyncExecution('"hello"');
      expect(result).toBe('(async () => {\nreturn ("hello");\n})()');
    });

    it('returns function call result', () => {
      const result = transformForAsyncExecution('Math.max(1, 2)');
      expect(result).toBe('(async () => {\nreturn (Math.max(1, 2));\n})()');
    });
  });

  describe('variable declaration hoisting', () => {
    it('hoists const declaration and returns assignment', () => {
      const result = transformForAsyncExecution('const x = 1;');
      expect(result).toBe('let x;\n(async () => {\nreturn (x = 1);\n})()');
    });

    it('hoists let declaration and returns assignment', () => {
      const result = transformForAsyncExecution('let x = 1;');
      expect(result).toBe('let x;\n(async () => {\nreturn (x = 1);\n})()');
    });

    it('hoists var declaration and returns assignment', () => {
      const result = transformForAsyncExecution('var x = 1;');
      expect(result).toBe('let x;\n(async () => {\nreturn (x = 1);\n})()');
    });

    it('hoists multiple declarations', () => {
      const result = transformForAsyncExecution('const x = 1, y = 2;');
      expect(result).toBe(
        'let x, y;\n(async () => {\nreturn (x = 1, y = 2);\n})()'
      );
    });

    it('hoists declaration without initializer', () => {
      const result = transformForAsyncExecution('let x;');
      // No assignment, just hoisting - empty IIFE body
      expect(result).toBe('let x;\n(async () => {})()');
    });

    it('hoists declaration followed by expression and returns expression', () => {
      const result = transformForAsyncExecution('const x = 1;\nx + 1');
      expect(result).toBe(
        'let x;\n(async () => {\nvoid (x = 1);\nreturn (x + 1);\n})()'
      );
    });

    it('removes trailing semicolon from returned expression', () => {
      const result = transformForAsyncExecution('const x = 1;\nx + 1;');
      expect(result).toBe(
        'let x;\n(async () => {\nvoid (x = 1);\nreturn (x + 1);\n})()'
      );
    });
  });

  describe('destructuring pattern hoisting', () => {
    it('hoists object destructuring', () => {
      const result = transformForAsyncExecution('const { a, b } = obj;');
      expect(result).toBe(
        'let a, b;\n(async () => {\nreturn (({ a, b } = obj));\n})()'
      );
    });

    it('hoists array destructuring', () => {
      const result = transformForAsyncExecution('const [a, b] = arr;');
      expect(result).toBe(
        'let a, b;\n(async () => {\nreturn (([a, b] = arr));\n})()'
      );
    });

    it('hoists nested destructuring', () => {
      const result = transformForAsyncExecution('const { a: { b } } = obj;');
      expect(result).toBe(
        'let b;\n(async () => {\nreturn (({ a: { b } } = obj));\n})()'
      );
    });

    it('hoists rest pattern in object', () => {
      const result = transformForAsyncExecution('const { a, ...rest } = obj;');
      expect(result).toBe(
        'let a, rest;\n(async () => {\nreturn (({ a, ...rest } = obj));\n})()'
      );
    });

    it('hoists rest pattern in array', () => {
      const result = transformForAsyncExecution(
        'const [first, ...rest] = arr;'
      );
      expect(result).toBe(
        'let first, rest;\n(async () => {\nreturn (([first, ...rest] = arr));\n})()'
      );
    });

    it('hoists default value patterns', () => {
      const result = transformForAsyncExecution('const { a = 1 } = obj;');
      expect(result).toBe(
        'let a;\n(async () => {\nreturn (({ a = 1 } = obj));\n})()'
      );
    });
  });

  describe('function declaration hoisting', () => {
    it('hoists function declaration with var', () => {
      const result = transformForAsyncExecution('function foo() { return 1; }');
      expect(result).toBe(
        'var foo;\n(async () => {\nreturn (foo = function foo() { return 1; });\n})()'
      );
    });

    it('hoists function followed by call', () => {
      const result = transformForAsyncExecution(
        'function add(a, b) { return a + b; }\nadd(1, 2)'
      );
      expect(result).toContain('var add;');
      expect(result).toContain(
        'void (add = function add(a, b) { return a + b; })'
      );
      expect(result).toContain('return (add(1, 2))');
    });
  });

  describe('class declaration hoisting', () => {
    it('hoists class declaration', () => {
      const result = transformForAsyncExecution('class Foo {}');
      expect(result).toBe(
        'let Foo;\n(async () => {\nreturn (Foo = class Foo {});\n})()'
      );
    });

    it('hoists class with methods', () => {
      const result = transformForAsyncExecution(
        'class Foo { bar() { return 1; } }'
      );
      expect(result).toContain('let Foo;');
      expect(result).toContain('Foo = class Foo { bar() { return 1; } }');
    });
  });

  describe('await expressions', () => {
    it('supports top-level await with hoisting', () => {
      const result = transformForAsyncExecution('await Promise.resolve(42)');
      expect(result).toBe(
        '(async () => {\nreturn (await Promise.resolve(42));\n})()'
      );
    });

    it('supports await in variable assignment with hoisting', () => {
      const result = transformForAsyncExecution(
        'const result = await fetch("/api");\nresult'
      );
      expect(result).toBe(
        'let result;\n(async () => {\nvoid (result = await fetch("/api"));\nreturn (result);\n})()'
      );
    });

    it('supports multiple await expressions with hoisting', () => {
      const result = transformForAsyncExecution(
        'const a = await foo();\nconst b = await bar();\na + b'
      );
      expect(result).toBe(
        'let a, b;\n(async () => {\nvoid (a = await foo());\nvoid (b = await bar());\nreturn (a + b);\n})()'
      );
    });

    it('supports await followed by expression', () => {
      const result = transformForAsyncExecution('await delay(100);\n"done"');
      expect(result).toBe(
        '(async () => {\nawait delay(100);\nreturn ("done");\n})()'
      );
    });

    it('supports await expression standalone (with semicolon)', () => {
      const result = transformForAsyncExecution('await delay(100);');
      expect(result).toBe('(async () => {\nreturn (await delay(100));\n})()');
    });
  });

  describe('complex statements', () => {
    it('preserves if statement', () => {
      const result = transformForAsyncExecution(
        'if (true) { console.log("yes"); }'
      );
      expect(result).toBe(
        '(async () => {\nif (true) { console.log("yes"); };\n})()'
      );
    });

    it('preserves for loop', () => {
      const result = transformForAsyncExecution(
        'for (let i = 0; i < 3; i++) {}'
      );
      expect(result).toBe(
        '(async () => {\nfor (let i = 0; i < 3; i++) {};\n})()'
      );
    });

    it('handles multiline code with declarations and final expression', () => {
      const code = `
const x = 1;
const y = 2;
x + y
      `.trim();
      const result = transformForAsyncExecution(code);
      expect(result).toContain('let x, y;');
      expect(result).toContain('void (x = 1)');
      expect(result).toContain('void (y = 2)');
      expect(result).toContain('return (x + y)');
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
    it('handles typical LLM-generated fetch pattern with hoisting', () => {
      const code = `
const response = await fetch('https://api.example.com/data');
const data = await response.json();
data
      `.trim();
      const result = transformForAsyncExecution(code);
      expect(result).toContain('let response, data;');
      expect(result).toContain(
        "void (response = await fetch('https://api.example.com/data'))"
      );
      expect(result).toContain('void (data = await response.json())');
      expect(result).toContain('return (data)');
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
      // try/catch is passed through as-is
      expect(result).toContain('try {');
      expect(result).toContain('catch (e)');
    });
  });

  describe('variable persistence across executions (REPL semantics)', () => {
    it('transforms code so variables are accessible in outer scope', () => {
      // This test verifies the transformation pattern that enables persistence
      const result = transformForAsyncExecution('const value = 42;');

      // Variable should be declared outside the IIFE
      expect(result).toContain('let value;');

      // The IIFE should contain an assignment, not a declaration
      expect(result).not.toContain('const value');
      expect(result).toContain('value = 42');
    });

    it('hoists variables from await expressions for persistence', () => {
      const result = transformForAsyncExecution(
        'const result = await Promise.resolve(42);'
      );

      // Variable should be declared outside the IIFE
      expect(result).toContain('let result;');

      // Assignment should be inside the IIFE
      expect(result).toContain('result = await Promise.resolve(42)');
    });
  });

  describe('integration: variables persist in vm.Context', () => {
    // These tests verify the transformed code actually works in a real vm context
    const vm = require('node:vm');

    it('variables persist across multiple executions', async () => {
      const context = vm.createContext({});

      // First execution: declare and assign variable
      const code1 = transformForAsyncExecution('const x = 42;');
      await vm.runInContext(code1, context);

      // Second execution: access the variable
      const code2 = transformForAsyncExecution('x + 1');
      const result = await vm.runInContext(code2, context);

      expect(result).toBe(43);
    });

    it('variables with await persist across executions', async () => {
      const context = vm.createContext({ Promise });

      // First execution: declare variable with await
      const code1 = transformForAsyncExecution(
        'const result = await Promise.resolve(100);'
      );
      await vm.runInContext(code1, context);

      // Second execution: access the variable
      const code2 = transformForAsyncExecution('result * 2');
      const result = await vm.runInContext(code2, context);

      expect(result).toBe(200);
    });

    it('multiple variables persist independently', async () => {
      const context = vm.createContext({ Promise });

      // First execution: declare multiple variables
      const code1 = transformForAsyncExecution('const a = 1; const b = 2;');
      await vm.runInContext(code1, context);

      // Second execution: use both variables
      const code2 = transformForAsyncExecution('a + b');
      const result = await vm.runInContext(code2, context);

      expect(result).toBe(3);
    });

    it('function declarations persist and can be called', async () => {
      const context = vm.createContext({});

      // First execution: declare function
      const code1 = transformForAsyncExecution(
        'function add(a, b) { return a + b; }'
      );
      await vm.runInContext(code1, context);

      // Second execution: call the function
      const code2 = transformForAsyncExecution('add(10, 20)');
      const result = await vm.runInContext(code2, context);

      expect(result).toBe(30);
    });

    it('destructured variables persist', async () => {
      const context = vm.createContext({});

      // First execution: destructure object
      const code1 = transformForAsyncExecution(
        'const obj = { x: 1, y: 2 }; const { x, y } = obj;'
      );
      await vm.runInContext(code1, context);

      // Second execution: access destructured variables
      const code2 = transformForAsyncExecution('x + y');
      const result = await vm.runInContext(code2, context);

      expect(result).toBe(3);
    });
  });
});
