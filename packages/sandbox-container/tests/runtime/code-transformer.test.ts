import { describe, expect, test } from 'bun:test';
import { transformForAsyncExecution } from '../../src/runtime/executors/shared/code-transformer';

describe('transformForAsyncExecution', () => {
  describe('basic expressions (should return value)', () => {
    test('single number', () => {
      const result = transformForAsyncExecution('42');
      expect(result).toBe('(async () => {\nreturn 42;\n})()');
    });

    test('single string', () => {
      const result = transformForAsyncExecution('"hello"');
      expect(result).toBe('(async () => {\nreturn "hello";\n})()');
    });

    test('identifier', () => {
      const result = transformForAsyncExecution('x');
      expect(result).toBe('(async () => {\nreturn x;\n})()');
    });

    test('property access', () => {
      const result = transformForAsyncExecution('data.items');
      expect(result).toBe('(async () => {\nreturn data.items;\n})()');
    });

    test('function call', () => {
      const result = transformForAsyncExecution('foo()');
      expect(result).toBe('(async () => {\nreturn foo();\n})()');
    });

    test('binary expression', () => {
      const result = transformForAsyncExecution('1 + 2');
      expect(result).toBe('(async () => {\nreturn 1 + 2;\n})()');
    });

    test('object literal', () => {
      const result = transformForAsyncExecution('({ a: 1, b: 2 })');
      expect(result).toBe('(async () => {\nreturn ({ a: 1, b: 2 });\n})()');
    });

    test('array literal', () => {
      const result = transformForAsyncExecution('[1, 2, 3]');
      expect(result).toBe('(async () => {\nreturn [1, 2, 3];\n})()');
    });

    test('expression with trailing semicolon', () => {
      const result = transformForAsyncExecution('42;');
      expect(result).toBe('(async () => {\nreturn 42;\n})()');
    });
  });

  describe('declarations (should return undefined)', () => {
    test('const declaration', () => {
      const result = transformForAsyncExecution('const x = 5');
      expect(result).toBe('(async () => {\nconst x = 5\n})()');
    });

    test('let declaration', () => {
      const result = transformForAsyncExecution('let x = 5');
      expect(result).toBe('(async () => {\nlet x = 5\n})()');
    });

    test('var declaration', () => {
      const result = transformForAsyncExecution('var x = 5');
      expect(result).toBe('(async () => {\nvar x = 5\n})()');
    });

    test('function declaration', () => {
      const result = transformForAsyncExecution('function foo() { return 1; }');
      expect(result).toBe('(async () => {\nfunction foo() { return 1; }\n})()');
    });

    test('class declaration', () => {
      const result = transformForAsyncExecution('class Foo {}');
      expect(result).toBe('(async () => {\nclass Foo {}\n})()');
    });
  });

  describe('mixed statements (declaration + expression)', () => {
    test('const then identifier', () => {
      const result = transformForAsyncExecution('const x = 5\nx');
      expect(result).toBe('(async () => {\nconst x = 5\nreturn x;\n})()');
    });

    test('const then expression', () => {
      const result = transformForAsyncExecution('const x = 5; x * 2');
      expect(result).toBe('(async () => {\nconst x = 5; return x * 2;\n})()');
    });

    test('multiple statements ending with expression', () => {
      const result = transformForAsyncExecution(
        'const a = 1\nconst b = 2\na + b'
      );
      expect(result).toBe(
        '(async () => {\nconst a = 1\nconst b = 2\nreturn a + b;\n})()'
      );
    });

    test('multiple statements ending with declaration', () => {
      const result = transformForAsyncExecution('const a = 1\nconst b = 2');
      expect(result).toBe('(async () => {\nconst a = 1\nconst b = 2\n})()');
    });
  });

  describe('async/await code', () => {
    test('single await expression', () => {
      const result = transformForAsyncExecution('await Promise.resolve(42)');
      expect(result).toBe(
        '(async () => {\nreturn await Promise.resolve(42);\n})()'
      );
    });

    test('await with assignment then expression', () => {
      const result = transformForAsyncExecution(
        'const x = await Promise.resolve(10)\nx * 2'
      );
      expect(result).toBe(
        '(async () => {\nconst x = await Promise.resolve(10)\nreturn x * 2;\n})()'
      );
    });

    test('multiple awaits ending with expression', () => {
      const code = `const a = await Promise.resolve(10)
const b = await Promise.resolve(20)
a + b`;
      const result = transformForAsyncExecution(code);
      expect(result).toContain('return a + b;');
      expect(result).toContain('const a = await Promise.resolve(10)');
      expect(result).toContain('const b = await Promise.resolve(20)');
    });

    test('async IIFE (already wrapped)', () => {
      const result = transformForAsyncExecution('(async () => 42)()');
      expect(result).toBe('(async () => {\nreturn (async () => 42)();\n})()');
    });
  });

  describe('edge cases', () => {
    test('empty string', () => {
      const result = transformForAsyncExecution('');
      expect(result).toBe('(async () => {})()');
    });

    test('whitespace only', () => {
      const result = transformForAsyncExecution('   \n   ');
      expect(result).toBe('(async () => {})()');
    });

    test('multiline expression', () => {
      const code = `{
  a: 1,
  b: 2
}`;
      const result = transformForAsyncExecution(code);
      // This is a block statement, not object literal - should not return
      expect(result).toContain('(async () => {');
      expect(result).toContain('})()');
    });

    test('parenthesized object literal', () => {
      const code = `({
  a: 1,
  b: 2
})`;
      const result = transformForAsyncExecution(code);
      expect(result).toContain('return ({');
    });

    test('syntax error passthrough', () => {
      const result = transformForAsyncExecution('const x =');
      // Should still wrap, let vm surface the error
      expect(result).toBe('(async () => {\nconst x =\n})()');
    });

    test('control flow statements', () => {
      const result = transformForAsyncExecution('if (true) { x = 1 }');
      expect(result).toBe('(async () => {\nif (true) { x = 1 }\n})()');
    });

    test('for loop', () => {
      const result = transformForAsyncExecution(
        'for (let i = 0; i < 10; i++) {}'
      );
      expect(result).toBe(
        '(async () => {\nfor (let i = 0; i < 10; i++) {}\n})()'
      );
    });
  });
});
