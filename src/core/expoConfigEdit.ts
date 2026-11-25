import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export const DYNAMIC_CONFIG_FILES = [
  'app.config.ts',
  'app.config.js',
  'app.config.cjs',
  'app.config.mjs',
] as const;

const EXPO_HINT_KEYS = new Set([
  'name',
  'slug',
  'version',
  'android',
  'ios',
  'extra',
  'plugins',
  'expo',
  'scheme',
  'owner',
]);

const DYNAMIC_SENTINEL = Symbol('DYNAMIC_UNRESOLVED');

export interface DynamicConfigTarget {
  obj: ts.ObjectLiteralExpression;
  /** Expression referencing Expo's base config parameter (e.g. `config` or `ctx.config`), if any. */
  configRefExpr: string | null;
  /** Non-null when `obj` itself spreads `...config` / `...ctx.config`. */
  spreadConfigExpr: string | null;
  /** Local variable bindings visible in the target's enclosing function/module scope. */
  localVars?: Map<string, ts.Expression>;
}

export interface StaticDynamicEvalResult {
  config: Record<string, any>;
  /** True when root spreads and target branches (`android`, `extra`) had no unresolvable dynamic expressions. */
  usable: boolean;
}

export interface SetDynamicConfigOpts {
  overwrite?: boolean;
  /** When true, throw a 409 error if the leaf is already set to a different value and `!overwrite`. */
  checkConflict?: boolean;
  /** Pre-resolved existing value (e.g. inherited from app.json via `...config`) to check conflicts against. */
  inheritedExistingValue?: string;
}

/**
 * Returns the absolute path to the highest-priority dynamic Expo config file
 * (`app.config.ts`, `app.config.js`, `app.config.cjs`, `app.config.mjs`) in
 * `cwd`, or `null` if none exists.
 */
export function findDynamicConfigFile(cwd: string): string | null {
  for (const name of DYNAMIC_CONFIG_FILES) {
    const full = path.join(cwd, name);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/** Returns the basename of the active Expo config file (`app.config.ts`, etc., or `app.json`). */
export function getExpoConfigFileLabel(cwd: string): string {
  const dyn = findDynamicConfigFile(cwd);
  return dyn ? path.basename(dyn) : 'app.json';
}

function unwrapExpr(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (true) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isAsExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isTypeAssertionExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isNonNullExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

function collectReassignedIdentifiers(node: ts.Node, out: Set<string>): void {
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) {
      const lhs = unwrapExpr(node.left);
      if (ts.isIdentifier(lhs)) out.add(lhs.text);
    }
  } else if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const op = node.operator;
    if (op === ts.SyntaxKind.PlusPlusToken || op === ts.SyntaxKind.MinusMinusToken) {
      const operand = unwrapExpr(node.operand);
      if (ts.isIdentifier(operand)) out.add(operand.text);
    }
  }
  ts.forEachChild(node, (child) => {
    collectReassignedIdentifiers(child, out);
  });
}

function collectLocalInitializers(statements: readonly ts.Statement[], scopeContainer: ts.Node): Map<string, ts.Expression> {
  const reassigned = new Set<string>();
  collectReassignedIdentifiers(scopeContainer, reassigned);

  const counts = new Map<string, number>();
  const map = new Map<string, ts.Expression>();
  for (const stmt of statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const id = decl.name.text;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (!reassigned.has(id)) {
        map.set(id, decl.initializer);
      }
    }
  }
  for (const [id, count] of counts) {
    if (count > 1) map.delete(id);
  }
  return map;
}

function isModuleExportsTarget(lhs: ts.Expression): boolean {
  const expr = unwrapExpr(lhs);
  if (!ts.isPropertyAccessExpression(expr)) return false;
  const prop = expr.name.text;
  const base = unwrapExpr(expr.expression);
  if (ts.isIdentifier(base)) {
    if (base.text === 'module' && prop === 'exports') return true;
    if (base.text === 'exports' && prop === 'default') return true;
  }
  if (prop === 'default' && ts.isPropertyAccessExpression(base)) {
    const inner = unwrapExpr(base.expression);
    if (ts.isIdentifier(inner) && inner.text === 'module' && base.name.text === 'exports') {
      return true;
    }
  }
  return false;
}

function findExportedExpression(sourceFile: ts.SourceFile, moduleVars: Map<string, ts.Expression>): ts.Node | null {
  let exported: ts.Node | null = null;
  for (const stmt of sourceFile.statements) {
    if (ts.isExportAssignment(stmt)) {
      exported = stmt.expression;
    } else if (
      ts.isFunctionDeclaration(stmt) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) &&
      stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
    ) {
      exported = stmt;
    } else if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const spec of stmt.exportClause.elements) {
        if (spec.name.text === 'default') {
          const localName = (spec.propertyName || spec.name).text;
          const bound = moduleVars.get(localName);
          if (bound) exported = bound;
        }
      }
    } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)) {
      if (stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && isModuleExportsTarget(stmt.expression.left)) {
        exported = stmt.expression.right;
      }
    }
  }
  return exported;
}

function getConfigRefFromParam(fn: ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration): string | null {
  if (!fn.parameters.length) return null;
  const param = fn.parameters[0];
  if (ts.isIdentifier(param.name)) {
    const name = param.name.text;
    return name.startsWith('_') ? null : `${name}.config`;
  }
  if (ts.isObjectBindingPattern(param.name)) {
    for (const el of param.name.elements) {
      const propName = el.propertyName ? getPropertyNameText(el.propertyName) : ts.isIdentifier(el.name) ? el.name.text : null;
      if (propName === 'config' && ts.isIdentifier(el.name) && !el.name.text.startsWith('_')) {
        return el.name.text;
      }
    }
  }
  return null;
}

function collectDirectReturnStatements(node: ts.Node, out: ts.ReturnStatement[]): void {
  if (ts.isReturnStatement(node)) {
    out.push(node);
    return;
  }
  // Never descend into nested functions or classes — their returns are not the config factory's returns.
  if (
    ts.isFunctionLike(node) ||
    ts.isClassLike(node)
  ) {
    return;
  }
  ts.forEachChild(node, (child) => {
    collectDirectReturnStatements(child, out);
  });
}

function hasObjectExpoHintKeys(obj: ts.ObjectLiteralExpression): boolean {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const name = getPropertyNameText(prop.name);
      if (name && EXPO_HINT_KEYS.has(name)) return true;
    }
  }
  return false;
}

function unwrapExpoWrapperObject(obj: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression {
  let hasRootExpoKeys = false;
  let expoChild: ts.ObjectLiteralExpression | null = null;
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const key = getPropertyNameText(prop.name);
    if (!key) continue;
    if (key === 'expo' && ts.isPropertyAssignment(prop)) {
      const init = unwrapExpr(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) expoChild = init;
    } else if (EXPO_HINT_KEYS.has(key)) {
      hasRootExpoKeys = true;
    }
  }
  return expoChild && !hasRootExpoKeys ? expoChild : obj;
}

function matchPropertyChain(expr: ts.Expression, baseDotPath: string): string[] | null {
  const unwrapped = unwrapExpr(expr);
  const parts: string[] = [];
  let cur: ts.Expression = unwrapped;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text);
    cur = unwrapExpr(cur.expression);
  }
  if (!ts.isIdentifier(cur)) return null;
  parts.unshift(cur.text);

  const baseParts = baseDotPath.split('.');
  if (parts.length < baseParts.length) return null;
  for (let i = 0; i < baseParts.length; i++) {
    if (parts[i] !== baseParts[i]) return null;
  }
  return parts.slice(baseParts.length);
}

function hasSpreadMatching(obj: ts.ObjectLiteralExpression, baseExpr: string, extraSegments: string[] = []): boolean {
  for (const prop of obj.properties) {
    if (!ts.isSpreadAssignment(prop)) continue;
    const chain = matchPropertyChain(prop.expression, baseExpr);
    if (!chain) continue;
    if (chain.length === extraSegments.length && chain.every((seg, i) => seg === extraSegments[i])) {
      return true;
    }
  }
  return false;
}

function resolveExpressionToObjectLiteral(
  expr: ts.Expression,
  vars: Map<string, ts.Expression>,
  visited = new Set<string>()
): ts.ObjectLiteralExpression | null {
  const cur = unwrapExpr(expr);
  if (ts.isObjectLiteralExpression(cur)) {
    return unwrapExpoWrapperObject(cur);
  }
  if (ts.isIdentifier(cur)) {
    if (visited.has(cur.text)) return null;
    const bound = vars.get(cur.text);
    if (!bound) return null;
    visited.add(cur.text);
    return resolveExpressionToObjectLiteral(bound, vars, visited);
  }
  if (ts.isCallExpression(cur) && cur.arguments.length >= 1) {
    const arg = unwrapExpr(cur.arguments[0]);
    const callee = unwrapExpr(cur.expression);
    const calleeName = ts.isIdentifier(callee) ? callee.text : '';
    if (
      ts.isObjectLiteralExpression(arg) &&
      (/^(with|define|create)/i.test(calleeName) || /config|expo/i.test(calleeName) || hasObjectExpoHintKeys(arg))
    ) {
      return unwrapExpoWrapperObject(arg);
    }
  }
  return null;
}

/**
 * Inspects an `app.config.*` source file and returns the target config
 * `ObjectLiteralExpression`(s) that can be safely edited, or `null` if the
 * file uses an unsupported dynamic pattern (e.g. importing/calling external
 * config builders).
 */
export function findDynamicConfigTargets(sourceFile: ts.SourceFile): DynamicConfigTarget[] | null {
  const moduleVars = collectLocalInitializers(sourceFile.statements, sourceFile);
  let node: ts.Node | null = findExportedExpression(sourceFile, moduleVars);
  if (!node) return null;

  const seenIds = new Set<string>();
  while (true) {
    if (ts.isExpression(node)) {
      node = unwrapExpr(node);
      if (ts.isIdentifier(node)) {
        if (seenIds.has(node.text)) return null;
        seenIds.add(node.text);
        const bound = moduleVars.get(node.text);
        if (!bound) return null;
        node = bound;
        continue;
      }
      if (ts.isCallExpression(node) && node.arguments.length >= 1) {
        const arg = unwrapExpr(node.arguments[0]);
        const callee = unwrapExpr(node.expression);
        const calleeName = ts.isIdentifier(callee) ? callee.text : '';
        const isFnArg = ts.isArrowFunction(arg) || ts.isFunctionExpression(arg);
        const isExpoObjArg =
          ts.isObjectLiteralExpression(arg) &&
          (/^(with|define|create)/i.test(calleeName) || /config|expo/i.test(calleeName) || hasObjectExpoHintKeys(arg));
        if (isFnArg || isExpoObjArg) {
          node = arg;
          continue;
        }
      }
    }
    break;
  }

  if (ts.isObjectLiteralExpression(node)) {
    const targetObj = unwrapExpoWrapperObject(node);
    return [{ obj: targetObj, configRefExpr: null, spreadConfigExpr: null, localVars: moduleVars }];
  }

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const configRefExpr = getConfigRefFromParam(node);
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const targetObj = resolveExpressionToObjectLiteral(node.body, moduleVars);
      if (!targetObj) return null;
      const spreadConfigExpr =
        configRefExpr && hasSpreadMatching(targetObj, configRefExpr) ? configRefExpr : null;
      return [{ obj: targetObj, configRefExpr, spreadConfigExpr, localVars: moduleVars }];
    }

    if (!node.body || !ts.isBlock(node.body)) return null;
    const returns: ts.ReturnStatement[] = [];
    for (const stmt of node.body.statements) {
      collectDirectReturnStatements(stmt, returns);
    }
    if (!returns.length) return null;

    const fnVars = new Map(moduleVars);
    for (const [k, v] of collectLocalInitializers(node.body.statements, node.body)) {
      fnVars.set(k, v);
    }

    const targets: DynamicConfigTarget[] = [];
    const seenObjStarts = new Set<number>();
    for (const ret of returns) {
      if (!ret.expression) return null;
      const targetObj = resolveExpressionToObjectLiteral(ret.expression, fnVars);
      if (!targetObj) return null;
      if (seenObjStarts.has(targetObj.pos)) continue;
      seenObjStarts.add(targetObj.pos);
      const spreadConfigExpr =
        configRefExpr && hasSpreadMatching(targetObj, configRefExpr) ? configRefExpr : null;
      targets.push({ obj: targetObj, configRefExpr, spreadConfigExpr, localVars: fnVars });
    }
    return targets.length ? targets : null;
  }

  return null;
}

/** Returns true when `app.config.*` in `cwd` (or `app.json`) can be edited safely. */
export function canEditExpoConfig(cwd: string): boolean {
  const dynPath = findDynamicConfigFile(cwd);
  if (!dynPath) return fs.existsSync(path.join(cwd, 'app.json'));
  try {
    const content = fs.readFileSync(dynPath, 'utf8');
    const sf = ts.createSourceFile(dynPath, content, ts.ScriptTarget.Latest, true);
    return !!findDynamicConfigTargets(sf);
  } catch {
    return false;
  }
}

function getByPath(obj: any, segments: string[]): any {
  let cur = obj;
  for (const s of segments) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[s];
  }
  return cur;
}

function evaluateStaticValue(
  expr: ts.Expression,
  baseConfig: Record<string, any>,
  configRefExpr: string | null,
  moduleVars: Map<string, ts.Expression>,
  visited = new Set<string>()
): any {
  const cur = unwrapExpr(expr);
  if (ts.isStringLiteral(cur) || ts.isNoSubstitutionTemplateLiteral(cur)) {
    return cur.text;
  }
  if (ts.isNumericLiteral(cur)) {
    return Number(cur.text);
  }
  if (cur.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (cur.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (cur.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(cur) && cur.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(cur.operand)) {
    return -Number(cur.operand.text);
  }
  if (ts.isArrayLiteralExpression(cur)) {
    const arr: any[] = [];
    for (const el of cur.elements) {
      if (ts.isSpreadElement(el)) {
        const spreadVal = evaluateStaticValue(el.expression, baseConfig, configRefExpr, moduleVars, visited);
        if (!Array.isArray(spreadVal)) return DYNAMIC_SENTINEL;
        arr.push(...spreadVal);
      } else {
        const val = evaluateStaticValue(el, baseConfig, configRefExpr, moduleVars, visited);
        if (val === DYNAMIC_SENTINEL) return DYNAMIC_SENTINEL;
        arr.push(val);
      }
    }
    return arr;
  }
  if (ts.isObjectLiteralExpression(cur)) {
    return evaluateStaticObject(cur, baseConfig, configRefExpr, moduleVars, visited).obj;
  }
  if (configRefExpr) {
    const chain = matchPropertyChain(cur, configRefExpr);
    if (chain) return getByPath(baseConfig, chain);
  }
  if (ts.isIdentifier(cur)) {
    if (cur.text === 'undefined') return undefined;
    if (visited.has(cur.text)) return DYNAMIC_SENTINEL;
    const bound = moduleVars.get(cur.text);
    if (!bound) return DYNAMIC_SENTINEL;
    const nextVisited = new Set(visited);
    nextVisited.add(cur.text);
    return evaluateStaticValue(bound, baseConfig, configRefExpr, moduleVars, nextVisited);
  }
  return DYNAMIC_SENTINEL;
}

interface StaticObjectResult {
  obj: Record<string, any>;
  hasUnresolvedSpread: boolean;
  unresolvedKeys: Set<string>;
}

function evaluateStaticObject(
  node: ts.ObjectLiteralExpression,
  baseConfig: Record<string, any>,
  configRefExpr: string | null,
  moduleVars: Map<string, ts.Expression>,
  visited = new Set<string>()
): StaticObjectResult & { childResults: Map<string, StaticObjectResult> } {
  const out: Record<string, any> = {};
  let hasUnresolvedSpread = false;
  const unresolvedKeys = new Set<string>();
  const childResults = new Map<string, StaticObjectResult>();

  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      const val = evaluateStaticValue(prop.expression, baseConfig, configRefExpr, moduleVars, visited);
      if (val === DYNAMIC_SENTINEL) {
        hasUnresolvedSpread = true;
      } else if (val && typeof val === 'object' && !Array.isArray(val)) {
        Object.assign(out, val);
      }
      continue;
    }
    if (ts.isPropertyAssignment(prop)) {
      const key = getPropertyNameText(prop.name);
      if (!key) {
        hasUnresolvedSpread = true;
        continue;
      }
      const init = unwrapExpr(prop.initializer);
      if (ts.isObjectLiteralExpression(init)) {
        const nested = evaluateStaticObject(init, baseConfig, configRefExpr, moduleVars, visited);
        out[key] = nested.obj;
        childResults.set(key, nested);
        unresolvedKeys.delete(key);
      } else {
        const val = evaluateStaticValue(init, baseConfig, configRefExpr, moduleVars, visited);
        if (val === DYNAMIC_SENTINEL) {
          unresolvedKeys.add(key);
          delete out[key];
          childResults.delete(key);
        } else {
          out[key] = val;
          unresolvedKeys.delete(key);
          childResults.delete(key);
        }
      }
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const key = prop.name.text;
      const val = evaluateStaticValue(prop.name, baseConfig, configRefExpr, moduleVars, visited);
      if (val === DYNAMIC_SENTINEL) {
        unresolvedKeys.add(key);
        delete out[key];
      } else {
        out[key] = val;
        unresolvedKeys.delete(key);
      }
      continue;
    }
    hasUnresolvedSpread = true;
  }

  return { obj: out, hasUnresolvedSpread, unresolvedKeys, childResults };
}

/**
 * Best-effort static evaluator for `app.config.*` when `expo config --json` is
 * unavailable (e.g. dependencies not installed yet or unit tests). Returns
 * `null` if the config object cannot be located or if critical fields
 * (`android.package` / `extra.eas.projectId`) are obscured by unresolvable
 * dynamic expressions.
 */
export function evaluateStaticDynamicConfig(cwd: string, dynamicFilePath: string): StaticDynamicEvalResult | null {
  let content: string;
  try {
    content = fs.readFileSync(dynamicFilePath, 'utf8');
  } catch {
    return null;
  }

  let baseConfig: Record<string, any> = {};
  const appJsonPath = path.join(cwd, 'app.json');
  if (fs.existsSync(appJsonPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      const inner = raw?.expo ?? raw;
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        baseConfig = inner;
      }
    } catch {
      // ignore malformed app.json
    }
  }

  const sf = ts.createSourceFile(dynamicFilePath, content, ts.ScriptTarget.Latest, true);
  const targets = findDynamicConfigTargets(sf);
  // Multiple conditional return branches depend on runtime env/branching, so only
  // statically resolve single-target configs without guessing.
  if (!targets || targets.length !== 1) return null;

  const target = targets[0];
  const scopeVars = target.localVars || collectLocalInitializers(sf.statements, sf);
  const rootEval = evaluateStaticObject(target.obj, baseConfig, target.configRefExpr, scopeVars);

  if (rootEval.hasUnresolvedSpread) return null;

  const androidUnresolved =
    rootEval.unresolvedKeys.has('android') ||
    (() => {
      const androidChild = rootEval.childResults.get('android');
      return !!androidChild && (androidChild.hasUnresolvedSpread || androidChild.unresolvedKeys.has('package'));
    })();

  const extraUnresolved =
    rootEval.unresolvedKeys.has('extra') ||
    (() => {
      const extraChild = rootEval.childResults.get('extra') as
        | (StaticObjectResult & { childResults?: Map<string, StaticObjectResult> })
        | undefined;
      if (!extraChild) return false;
      if (extraChild.hasUnresolvedSpread || extraChild.unresolvedKeys.has('eas')) return true;
      const easChild = extraChild.childResults?.get('eas');
      return !!easChild && (easChild.hasUnresolvedSpread || easChild.unresolvedKeys.has('projectId'));
    })();

  if (androidUnresolved || extraUnresolved) {
    return null;
  }

  return { config: rootEval.obj, usable: true };
}

function detectEol(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function detectQuoteStyle(text: string, obj: ts.ObjectLiteralExpression): "'" | '"' {
  let single = 0;
  let dbl = 0;
  const count = (node: ts.Node) => {
    if (ts.isStringLiteral(node)) {
      const raw = text.slice(node.getStart(), node.getEnd());
      if (raw.startsWith("'")) single++;
      else if (raw.startsWith('"')) dbl++;
    }
    ts.forEachChild(node, count);
  };
  count(obj);
  if (single === 0 && dbl === 0) count(obj.getSourceFile());
  return dbl > single ? '"' : "'";
}

function formatStringLiteral(value: string, quote: "'" | '"'): string {
  if (quote === '"') return JSON.stringify(value);
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  return `'${escaped}'`;
}

function lineIndentAt(text: string, pos: number): string {
  let lineStart = text.lastIndexOf('\n', Math.max(0, pos - 1));
  lineStart = lineStart === -1 ? 0 : lineStart + 1;
  let end = lineStart;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
  return text.slice(lineStart, end);
}

function detectIndentUnit(text: string, sf: ts.SourceFile, obj: ts.ObjectLiteralExpression, parentIndent: string): string {
  for (const prop of obj.properties) {
    const start = prop.getStart(sf);
    const prevNl = text.lastIndexOf('\n', start - 1);
    const linePrefix = text.slice(prevNl === -1 ? 0 : prevNl + 1, start);
    if (/^[ \t]+$/.test(linePrefix) && linePrefix.startsWith(parentIndent)) {
      const diff = linePrefix.slice(parentIndent.length);
      if (diff.length > 0) return diff;
    }
  }
  const m = text.match(/\n([ \t]+)\S/);
  if (m && m[1]) {
    if (m[1].startsWith('\t')) return '\t';
    if (m[1].length >= 4) return '    ';
  }
  return '  ';
}

function findObjectProp(
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  key: string
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | null {
  let found: ts.PropertyAssignment | ts.ShorthandPropertyAssignment | null = null;
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      const propKey = getPropertyNameText(prop.name);
      if (propKey === key) found = prop;
    }
  }
  return found;
}

function findSpreadPrefixForPath(
  obj: ts.ObjectLiteralExpression,
  configRefExpr: string | null,
  parentPath: string[]
): string | null {
  if (!configRefExpr) return null;
  if (!hasSpreadMatching(obj, configRefExpr, parentPath)) return null;
  if (parentPath.length === 0) return configRefExpr;
  // Use optional chaining after the first segment (e.g. `config.extra?.eas`) so
  // TypeScript and runtime never fail when `config.extra` is undefined.
  return parentPath.reduce((acc, seg, idx) => (idx === 0 ? `${acc}.${seg}` : `${acc}?.${seg}`), configRefExpr);
}

function buildNestedPropertyBlock(
  keys: string[],
  valueText: string,
  opts: {
    baseIndent: string;
    indentUnit: string;
    eol: '\r\n' | '\n';
    trailingComma: boolean;
    spreadChainBase: string | null;
    spreadDepthStart: number;
  }
): string {
  const { baseIndent, indentUnit, eol, trailingComma, spreadChainBase } = opts;
  const key = keys[0];
  if (keys.length === 1) {
    return `${baseIndent}${key}: ${valueText}`;
  }
  const innerIndent = baseIndent + indentUnit;
  const lines: string[] = [`${baseIndent}${key}: {`];
  if (spreadChainBase) {
    const spreadExpr =
      opts.spreadDepthStart === 0
        ? `${spreadChainBase}.${key}`
        : `${spreadChainBase}?.${key}`;
    lines.push(`${innerIndent}...${spreadExpr},`);
  }
  const inner = buildNestedPropertyBlock(keys.slice(1), valueText, {
    baseIndent: innerIndent,
    indentUnit,
    eol,
    trailingComma: true,
    spreadChainBase: spreadChainBase
      ? opts.spreadDepthStart === 0
        ? `${spreadChainBase}.${key}`
        : `${spreadChainBase}?.${key}`
      : null,
    spreadDepthStart: opts.spreadDepthStart + 1,
  });
  lines.push(`${inner}${trailingComma ? ',' : ''}`);
  lines.push(`${baseIndent}}`);
  return lines.join(eol);
}

interface TextSplice {
  start: number;
  end: number;
  text: string;
}

function applySplices(source: string, splices: TextSplice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const s of sorted) {
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return out;
}

function setPropertyOnTarget(
  text: string,
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  pathKeys: string[],
  value: string,
  opts: {
    configRefExpr: string | null;
    overwrite: boolean;
    checkConflict: boolean;
    inheritedExistingValue?: string;
    quote: "'" | '"';
    eol: '\r\n' | '\n';
    indentUnit: string;
  },
  parentPath: string[] = []
): TextSplice[] {
  const key = pathKeys[0];
  const existingProp = findObjectProp(sf, obj, key);
  const quotedValue = formatStringLiteral(value, opts.quote);

  if (pathKeys.length === 1) {
    if (existingProp) {
      if (ts.isShorthandPropertyAssignment(existingProp)) {
        if (opts.checkConflict && !opts.overwrite) {
          const err: any = new Error(
            `This project is already linked (extra.eas.projectId is set to ${existingProp.name.text}). Confirm before replacing it.`
          );
          err.status = 409;
          throw err;
        }
        return [{
          start: existingProp.getStart(sf),
          end: existingProp.getEnd(),
          text: `${key}: ${quotedValue}`,
        }];
      }

      const init = unwrapExpr(existingProp.initializer);
      let existingStr: string | undefined;
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        existingStr = init.text;
      }
      if (opts.checkConflict && !opts.overwrite) {
        if (existingStr && existingStr !== value) {
          const err: any = new Error(
            `This project is already linked to EAS project ${existingStr}. Confirm before replacing it.`
          );
          err.status = 409;
          throw err;
        }
        if (!existingStr) {
          const rawExpr = existingProp.initializer.getText(sf).trim();
          const err: any = new Error(
            `This project is already linked (extra.eas.projectId is set to ${rawExpr}). Confirm before replacing it.`
          );
          err.status = 409;
          throw err;
        }
      }
      if (existingStr === value) {
        return [];
      }
      const existingRaw = text.slice(init.getStart(sf), init.getEnd());
      const leafQuote: "'" | '"' = existingRaw.startsWith('"') ? '"' : existingRaw.startsWith("'") ? "'" : opts.quote;
      return [{
        start: init.getStart(sf),
        end: init.getEnd(),
        text: formatStringLiteral(value, leafQuote),
      }];
    }

    // Key does not exist at this level; if an inherited value from `...config` conflicted, check before overriding.
    if (opts.checkConflict && opts.inheritedExistingValue && opts.inheritedExistingValue !== value && !opts.overwrite) {
      const err: any = new Error(
        `This project is already linked to EAS project ${opts.inheritedExistingValue}. Confirm before replacing it.`
      );
      err.status = 409;
      throw err;
    }

    return insertMissingProperty(text, sf, obj, pathKeys, quotedValue, {
      configRefExpr: opts.configRefExpr,
      eol: opts.eol,
      indentUnit: opts.indentUnit,
    }, parentPath);
  }

  // Intermediate path segment
  if (existingProp) {
    if (ts.isShorthandPropertyAssignment(existingProp)) {
      if (opts.checkConflict && opts.inheritedExistingValue && opts.inheritedExistingValue !== value && !opts.overwrite) {
        const err: any = new Error(
          `This project is already linked to EAS project ${opts.inheritedExistingValue}. Confirm before replacing it.`
        );
        err.status = 409;
        throw err;
      }
      const propStart = existingProp.getStart(sf);
      const propIndent = lineIndentAt(text, propStart);
      const childIndent = propIndent + opts.indentUnit;
      const restBlock = buildNestedPropertyBlock(pathKeys.slice(1), quotedValue, {
        baseIndent: childIndent,
        indentUnit: opts.indentUnit,
        eol: opts.eol,
        trailingComma: true,
        spreadChainBase: null,
        spreadDepthStart: 1,
      });
      const replacement = `${key}: {${opts.eol}${childIndent}...${key},${opts.eol}${restBlock},${opts.eol}${propIndent}}`;
      return [{ start: propStart, end: existingProp.getEnd(), text: replacement }];
    }

    const init = unwrapExpr(existingProp.initializer);
    if (ts.isObjectLiteralExpression(init)) {
      return setPropertyOnTarget(text, sf, init, pathKeys.slice(1), value, opts, [...parentPath, key]);
    }

    if (opts.checkConflict && opts.inheritedExistingValue && opts.inheritedExistingValue !== value && !opts.overwrite) {
      const err: any = new Error(
        `This project is already linked to EAS project ${opts.inheritedExistingValue}. Confirm before replacing it.`
      );
      err.status = 409;
      throw err;
    }

    const initStart = init.getStart(sf);
    const initEnd = init.getEnd();
    const propIndent = lineIndentAt(text, existingProp.getStart(sf));
    const childIndent = propIndent + opts.indentUnit;
    const isNullish =
      init.kind === ts.SyntaxKind.NullKeyword ||
      (ts.isIdentifier(init) && init.text === 'undefined');
    const restBlock = buildNestedPropertyBlock(pathKeys.slice(1), quotedValue, {
      baseIndent: childIndent,
      indentUnit: opts.indentUnit,
      eol: opts.eol,
      trailingComma: true,
      spreadChainBase: null,
      spreadDepthStart: 1,
    });
    const replacement = isNullish
      ? `{${opts.eol}${restBlock},${opts.eol}${propIndent}}`
      : `{${opts.eol}${childIndent}...${text.slice(initStart, initEnd)},${opts.eol}${restBlock},${opts.eol}${propIndent}}`;
    return [{ start: initStart, end: initEnd, text: replacement }];
  }

  if (opts.checkConflict && opts.inheritedExistingValue && opts.inheritedExistingValue !== value && !opts.overwrite) {
    const err: any = new Error(
      `This project is already linked to EAS project ${opts.inheritedExistingValue}. Confirm before replacing it.`
    );
    err.status = 409;
    throw err;
  }

  return insertMissingProperty(text, sf, obj, pathKeys, quotedValue, {
    configRefExpr: opts.configRefExpr,
    eol: opts.eol,
    indentUnit: opts.indentUnit,
  }, parentPath);
}

function insertMissingProperty(
  text: string,
  sf: ts.SourceFile,
  obj: ts.ObjectLiteralExpression,
  pathKeys: string[],
  quotedValue: string,
  opts: {
    configRefExpr: string | null;
    eol: '\r\n' | '\n';
    indentUnit: string;
  },
  parentPath: string[]
): TextSplice[] {
  const openBracePos = obj.getStart(sf);
  const closeBracePos = obj.getEnd() - 1;
  const objText = text.slice(openBracePos, obj.getEnd());
  const isMultiline = objText.includes('\n');

  const closeLineIndent = lineIndentAt(text, closeBracePos);
  const openLineIndent = lineIndentAt(text, openBracePos);
  // When `}` sits on its own line (common multiline), `closeLineIndent` is the object's base indent.
  const closeOnOwnLine = (() => {
    let i = closeBracePos - 1;
    while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
    return i >= 0 && text[i] === '\n';
  })();
  const parentIndent = closeOnOwnLine ? closeLineIndent : openLineIndent;
  const childIndent = parentIndent + opts.indentUnit;
  const spreadBase = findSpreadPrefixForPath(obj, opts.configRefExpr, parentPath);
  const spreadDepthStart = parentPath.length;

  const hasTrailingComma = obj.properties.hasTrailingComma;
  const useTrailingComma = obj.properties.length === 0 ? true : hasTrailingComma;
  const propBlock = buildNestedPropertyBlock(pathKeys, quotedValue, {
    baseIndent: childIndent,
    indentUnit: opts.indentUnit,
    eol: opts.eol,
    trailingComma: true,
    spreadChainBase: spreadBase,
    spreadDepthStart,
  });
  const isSingleLineProp = !propBlock.includes('\n');

  // Empty `{}` or `{ /* comment */ }`
  if (obj.properties.length === 0) {
    const innerBetween = text.slice(openBracePos + 1, closeBracePos);
    if (!innerBetween.trim()) {
      return [{
        start: openBracePos + 1,
        end: closeBracePos,
        text: `${opts.eol}${propBlock},${opts.eol}${parentIndent}`,
      }];
    }
    if (closeOnOwnLine) {
      const insertAt = closeBracePos - closeLineIndent.length;
      return [{
        start: insertAt,
        end: insertAt,
        text: `${propBlock},${opts.eol}`,
      }];
    }
    return [{
      start: closeBracePos,
      end: closeBracePos,
      text: `${opts.eol}${propBlock},${opts.eol}${parentIndent}`,
    }];
  }

  const lastProp = obj.properties[obj.properties.length - 1];
  const lastPropEnd = lastProp.getEnd();

  if (!isMultiline) {
    if (isSingleLineProp) {
      const inlineProp = propBlock.trimStart();
      return [{
        start: lastPropEnd,
        end: lastPropEnd,
        text: `, ${inlineProp}`,
      }];
    }
    // Single-line parent expanding to accommodate a multiline nested property
    const splices: TextSplice[] = [];
    if (!hasTrailingComma) {
      splices.push({ start: lastPropEnd, end: lastPropEnd, text: ',' });
    }
    let trimStart = closeBracePos;
    while (trimStart > lastPropEnd && (text[trimStart - 1] === ' ' || text[trimStart - 1] === '\t')) {
      trimStart--;
    }
    splices.push({
      start: trimStart,
      end: closeBracePos,
      text: `${opts.eol}${propBlock}${hasTrailingComma ? ',' : ''}${opts.eol}${parentIndent}`,
    });
    return splices;
  }

  const splices: TextSplice[] = [];
  if (!hasTrailingComma) {
    splices.push({ start: lastPropEnd, end: lastPropEnd, text: ',' });
  }
  const trailing = useTrailingComma ? ',' : '';
  if (closeOnOwnLine) {
    const insertAt = closeBracePos - closeLineIndent.length;
    splices.push({
      start: insertAt,
      end: insertAt,
      text: `${propBlock}${trailing}${opts.eol}`,
    });
  } else {
    splices.push({
      start: closeBracePos,
      end: closeBracePos,
      text: `${opts.eol}${propBlock}${trailing}${opts.eol}${parentIndent}`,
    });
  }
  return splices;
}

/**
 * Sets a string value at `pathKeys` (e.g. `['extra', 'eas', 'projectId']` or
 * `['android', 'package']` or `['version']`) inside a dynamic `app.config.*`
 * file, preserving existing formatting, comments, imports, and TypeScript types.
 */
export function setDynamicConfigValue(
  filePath: string,
  pathKeys: string[],
  value: string,
  opts: SetDynamicConfigOpts = {}
): void {
  let text = fs.readFileSync(filePath, 'utf8');
  let sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
  const initialTargets = findDynamicConfigTargets(sf);
  if (!initialTargets || !initialTargets.length) {
    const err: any = new Error(
      `Your project uses ${path.basename(filePath)}, whose config object is constructed dynamically and cannot be updated automatically.`
    );
    err.status = 409;
    err.uneditableDynamicConfig = true;
    throw err;
  }

  const eol = detectEol(text);
  const targetCount = initialTargets.length;

  for (let i = 0; i < targetCount; i++) {
    sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true);
    const targets = findDynamicConfigTargets(sf);
    if (!targets || targets.length !== targetCount) {
      throw new Error(`Unexpected AST change while updating ${path.basename(filePath)}.`);
    }
    const target = targets[i];
    const quote = detectQuoteStyle(text, target.obj);
    const closeBracePos = target.obj.getEnd() - 1;
    const parentIndent = lineIndentAt(text, closeBracePos);
    const indentUnit = detectIndentUnit(text, sf, target.obj, parentIndent);

    const splices = setPropertyOnTarget(text, sf, target.obj, pathKeys, value, {
      configRefExpr: target.configRefExpr,
      overwrite: !!opts.overwrite,
      checkConflict: !!opts.checkConflict,
      inheritedExistingValue: opts.inheritedExistingValue,
      quote,
      eol,
      indentUnit,
    });
    if (splices.length) {
      text = applySplices(text, splices);
    }
  }

  fs.writeFileSync(filePath, text, 'utf8');
}

/**
 * Returns true if the dynamic `app.config.*` file directly defines a property
 * (literal or dynamic) at `pathKeys`.
 */
export function hasDynamicConfigProperty(filePath: string, pathKeys: string[]): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const targets = findDynamicConfigTargets(sf);
  if (!targets || !targets.length) return false;

  for (const target of targets) {
    let curObj: ts.ObjectLiteralExpression = target.obj;
    let matched = true;
    for (let i = 0; i < pathKeys.length; i++) {
      const prop = findObjectProp(sf, curObj, pathKeys[i]);
      if (!prop) {
        matched = false;
        break;
      }
      if (i === pathKeys.length - 1) break;
      if (!ts.isPropertyAssignment(prop)) {
        matched = false;
        break;
      }
      const init = unwrapExpr(prop.initializer);
      if (!ts.isObjectLiteralExpression(init)) {
        matched = false;
        break;
      }
      curObj = init;
    }
    if (!matched) return false;
  }
  return true;
}

/**
 * Reads a statically-written string literal at `pathKeys` from `app.config.*`
 * without failing if unrelated fields in the same file are dynamic.
 */
export function readStaticLiteralFromDynamicConfig(filePath: string, pathKeys: string[]): string | undefined {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const targets = findDynamicConfigTargets(sf);
  if (!targets || targets.length !== 1) return undefined;

  let curObj: ts.ObjectLiteralExpression = targets[0].obj;
  for (let i = 0; i < pathKeys.length; i++) {
    const prop = findObjectProp(sf, curObj, pathKeys[i]);
    if (!prop || !ts.isPropertyAssignment(prop)) return undefined;
    const init = unwrapExpr(prop.initializer);
    if (i === pathKeys.length - 1) {
      if (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) {
        return init.text;
      }
      return undefined;
    }
    if (!ts.isObjectLiteralExpression(init)) return undefined;
    curObj = init;
  }
  return undefined;
}

/**
 * Returns true if the dynamic `app.config.*` file directly defines a string
 * literal at `pathKeys` (as opposed to inheriting from `app.json` or computing
 * dynamically). Used by `bumpVersion` to know whether to update `version` in
 * `app.config.*` or `app.json`.
 */
export function hasStaticLiteralInDynamicConfig(filePath: string, pathKeys: string[]): boolean {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return false;
  }
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
  const targets = findDynamicConfigTargets(sf);
  if (!targets || !targets.length) return false;

  for (const target of targets) {
    let curObj: ts.ObjectLiteralExpression = target.obj;
    let matched = true;
    for (let i = 0; i < pathKeys.length; i++) {
      const prop = findObjectProp(sf, curObj, pathKeys[i]);
      if (!prop || !ts.isPropertyAssignment(prop)) {
        matched = false;
        break;
      }
      const init = unwrapExpr(prop.initializer);
      if (i === pathKeys.length - 1) {
        if (!ts.isStringLiteral(init) && !ts.isNoSubstitutionTemplateLiteral(init)) {
          matched = false;
        }
      } else {
        if (!ts.isObjectLiteralExpression(init)) {
          matched = false;
          break;
        }
        curObj = init;
      }
    }
    if (!matched) return false;
  }
  return true;
}
