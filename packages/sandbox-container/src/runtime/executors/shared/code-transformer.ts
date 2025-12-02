import type {
  ArrayPattern,
  AssignmentProperty,
  ClassDeclaration,
  ExpressionStatement,
  FunctionDeclaration,
  Identifier,
  Node,
  ObjectPattern,
  Pattern,
  Program,
  RestElement,
  Statement,
  VariableDeclaration,
  VariableDeclarator
} from 'acorn';
import * as acorn from 'acorn';

/**
 * Represents a variable declaration that needs to be hoisted.
 */
interface HoistedDeclaration {
  /** Variable names to declare in outer scope */
  names: string[];
  /** The transformed assignment code (or empty for declarations without init) */
  assignment: string;
}

/**
 * Extracts all identifier names from a pattern (handles destructuring).
 * Recursively processes ObjectPattern, ArrayPattern, RestElement, and AssignmentPattern.
 */
function extractIdentifiersFromPattern(pattern: Pattern): string[] {
  const names: string[] = [];

  switch (pattern.type) {
    case 'Identifier':
      names.push((pattern as Identifier).name);
      break;

    case 'ObjectPattern': {
      const objPattern = pattern as ObjectPattern;
      for (const prop of objPattern.properties) {
        if (prop.type === 'RestElement') {
          names.push(...extractIdentifiersFromPattern(prop.argument));
        } else {
          // AssignmentProperty
          const assignProp = prop as AssignmentProperty;
          names.push(
            ...extractIdentifiersFromPattern(assignProp.value as Pattern)
          );
        }
      }
      break;
    }

    case 'ArrayPattern': {
      const arrPattern = pattern as ArrayPattern;
      for (const element of arrPattern.elements) {
        if (element !== null) {
          names.push(...extractIdentifiersFromPattern(element));
        }
      }
      break;
    }

    case 'RestElement': {
      const restElement = pattern as RestElement;
      names.push(...extractIdentifiersFromPattern(restElement.argument));
      break;
    }

    case 'AssignmentPattern': {
      // Default value pattern: { a = 1 } or [a = 1]
      // The identifier is on the left side
      const assignPattern = pattern as { left: Pattern; right: Node };
      names.push(...extractIdentifiersFromPattern(assignPattern.left));
      break;
    }

    case 'MemberExpression':
      // MemberExpression can appear in patterns but doesn't introduce new bindings
      break;
  }

  return names;
}

/**
 * Processes a variable declaration and returns hoisting info.
 * Converts: const x = 1; -> hoisted "let x;" + assignment "x = 1;"
 * Handles destructuring: const {a, b} = obj; -> hoisted "let a, b;" + assignment "({a, b} = obj);"
 */
function processVariableDeclaration(
  decl: VariableDeclaration,
  source: string
): HoistedDeclaration {
  const allNames: string[] = [];
  const assignments: string[] = [];

  for (const declarator of decl.declarations) {
    const names = extractIdentifiersFromPattern(declarator.id);
    allNames.push(...names);

    if (declarator.init !== null && declarator.init !== undefined) {
      // Get the pattern text from source
      const patternText = source.slice(declarator.id.start, declarator.id.end);
      const initText = source.slice(declarator.init.start, declarator.init.end);

      // For destructuring patterns, wrap in parentheses to make it a valid expression
      if (
        declarator.id.type === 'ObjectPattern' ||
        declarator.id.type === 'ArrayPattern'
      ) {
        assignments.push(`(${patternText} = ${initText})`);
      } else {
        assignments.push(`${patternText} = ${initText}`);
      }
    }
  }

  return {
    names: allNames,
    assignment: assignments.length > 0 ? assignments.join(', ') : ''
  };
}

/**
 * Processes a function declaration for hoisting.
 * Converts: function foo() {} -> hoisted "var foo;" + assignment "foo = function foo() {}"
 */
function processFunctionDeclaration(
  decl: FunctionDeclaration,
  source: string
): HoistedDeclaration {
  // Anonymous functions (e.g., export default function() {}) have no id
  if (!decl.id) {
    return { names: [], assignment: '' };
  }
  const name = decl.id.name;
  const funcText = source.slice(decl.start, decl.end);

  return {
    names: [name],
    // Convert declaration to expression and assign
    assignment: `${name} = ${funcText}`
  };
}

/**
 * Processes a class declaration for hoisting.
 * Converts: class Foo {} -> hoisted "let Foo;" + assignment "Foo = class Foo {}"
 */
function processClassDeclaration(
  decl: ClassDeclaration,
  source: string
): HoistedDeclaration {
  // Anonymous classes (e.g., export default class {}) have no id
  if (!decl.id) {
    return { names: [], assignment: '' };
  }
  const name = decl.id.name;
  const classText = source.slice(decl.start, decl.end);

  return {
    names: [name],
    // Convert declaration to expression and assign
    assignment: `${name} = ${classText}`
  };
}

/**
 * Transforms code to support top-level await with proper variable hoisting.
 * This implements REPL-style semantics where variables declared with const/let/var
 * persist across executions by hoisting declarations outside the async IIFE wrapper.

 */
export function transformForAsyncExecution(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) {
    return '(async () => {})()';
  }

  try {
    const ast: Program = acorn.parse(trimmed, {
      ecmaVersion: 'latest',
      sourceType: 'script',
      allowAwaitOutsideFunction: true
    });

    const body = ast.body as Statement[];
    if (body.length === 0) {
      return '(async () => {})()';
    }

    // Collect hoisted declarations and transformed body parts
    const hoistedVars: string[] = []; // Variables declared with let in outer scope
    const hoistedFuncs: string[] = []; // Functions use var for hoisting semantics
    const bodyParts: string[] = [];

    for (let i = 0; i < body.length; i++) {
      const node = body[i];
      const isLast = i === body.length - 1;

      switch (node.type) {
        case 'VariableDeclaration': {
          const varDecl = node as VariableDeclaration;
          const hoisted = processVariableDeclaration(varDecl, trimmed);

          // Hoist all variable names (use let for const/let, var would also work)
          if (hoisted.names.length > 0) {
            hoistedVars.push(...hoisted.names);
          }

          // Add assignment to body (or void 0 if no initializer)
          if (hoisted.assignment) {
            if (isLast) {
              // Return the assignment result for last statement
              bodyParts.push(`return (${hoisted.assignment})`);
            } else {
              bodyParts.push(`void (${hoisted.assignment})`);
            }
          }
          // If no assignment (e.g., "let x;"), nothing to add to body
          break;
        }

        case 'FunctionDeclaration': {
          const funcDecl = node as FunctionDeclaration;
          const hoisted = processFunctionDeclaration(funcDecl, trimmed);

          // Use var for function hoisting semantics
          hoistedFuncs.push(...hoisted.names);

          if (hoisted.assignment) {
            if (isLast) {
              bodyParts.push(`return (${hoisted.assignment})`);
            } else {
              bodyParts.push(`void (${hoisted.assignment})`);
            }
          }
          break;
        }

        case 'ClassDeclaration': {
          const classDecl = node as ClassDeclaration;
          const hoisted = processClassDeclaration(classDecl, trimmed);

          hoistedVars.push(...hoisted.names);

          if (hoisted.assignment) {
            if (isLast) {
              bodyParts.push(`return (${hoisted.assignment})`);
            } else {
              bodyParts.push(`void (${hoisted.assignment})`);
            }
          }
          break;
        }

        case 'ExpressionStatement': {
          const exprStmt = node as ExpressionStatement;
          const exprText = trimmed.slice(exprStmt.start, exprStmt.end);
          // Remove trailing semicolon if present (we add our own when joining)
          const cleanedExpr = exprText.replace(/;$/, '');

          if (isLast) {
            bodyParts.push(`return (${cleanedExpr})`);
          } else {
            bodyParts.push(cleanedExpr);
          }
          break;
        }

        default: {
          // For other statements (if, for, while, try, etc.), include as-is
          const stmtText = trimmed.slice(node.start, node.end);
          bodyParts.push(stmtText);
          break;
        }
      }
    }

    // Build the final code
    const parts: string[] = [];

    // Add hoisted variable declarations
    if (hoistedVars.length > 0) {
      parts.push(`let ${hoistedVars.join(', ')};`);
    }

    // Add hoisted function declarations (use var for proper hoisting)
    if (hoistedFuncs.length > 0) {
      parts.push(`var ${hoistedFuncs.join(', ')};`);
    }

    // Add the async IIFE with transformed body
    if (bodyParts.length > 0) {
      const bodyCode = bodyParts.join(';\n');
      parts.push(`(async () => {\n${bodyCode};\n})()`);
    } else {
      // No body statements (e.g., just "let x;") - empty IIFE
      parts.push('(async () => {})()');
    }

    return parts.join('\n');
  } catch {
    // If acorn parsing fails (e.g., syntax error), wrap the original code anyway.
    // When vm.runInContext() executes this invalid code, it throws a SyntaxError
    // which is caught in node_executor.ts:109-112 and written to stderr.
    // This defers error reporting to V8, which provides better error messages
    // with accurate line/column information.
    return `(async () => {\n${trimmed}\n})()`;
  }
}
