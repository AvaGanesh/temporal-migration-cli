/**
 * Module 1 — Scanner.
 *
 * Milestone 1 scope: Luxon only (see plan's Build Order). The algorithm is
 * written to generalize to the other three libraries later — adding one is
 * just adding an entry to LIBRARY_MATCHERS — but only Luxon is wired in for
 * now, per the milestone's stated acceptance criteria.
 */
import { createHash } from 'node:crypto';
import {
  Identifier,
  ImportDeclaration,
  Node,
  Project,
  SourceFile,
  SyntaxKind,
} from 'ts-morph';
import type { FlowUse, Range, SourceLibrary, UsageSite } from './types.js';

interface LibraryMatcher {
  library: SourceLibrary;
  test: (moduleSpecifier: string) => boolean;
}

// Only Luxon is enabled for Milestone 1. Future milestones add matchers here
// for 'moment', 'date-fns' (and 'date-fns/*'), and 'dayjs' (and 'dayjs/plugin/*').
const LIBRARY_MATCHERS: LibraryMatcher[] = [
  { library: 'luxon', test: (spec) => spec === 'luxon' },
];

function matchLibrary(moduleSpecifier: string): SourceLibrary | undefined {
  return LIBRARY_MATCHERS.find((m) => m.test(moduleSpecifier))?.library;
}

/** The local binding identifiers introduced by a matched import declaration. */
function getImportBindingNames(importDecl: ImportDeclaration): Identifier[] {
  const names: Identifier[] = [];
  const defaultImport = importDecl.getDefaultImport();
  if (defaultImport) names.push(defaultImport);
  const namespaceImport = importDecl.getNamespaceImport();
  if (namespaceImport) names.push(namespaceImport);
  for (const named of importDecl.getNamedImports()) {
    const alias = named.getAliasNode();
    const localName = alias ?? named.getNameNode();
    if (Node.isIdentifier(localName)) {
      names.push(localName);
    }
  }
  return names;
}

/** A stable, canonical key for the variable/symbol an identifier refers to. */
function canonicalKeyFor(id: Identifier): string {
  const decl = id.getSymbol()?.getDeclarations()?.[0];
  const anchor = decl ?? id;
  return `${anchor.getSourceFile().getFilePath()}#${anchor.getStart()}`;
}

/**
 * Climb from a reference identifier to the outermost node of the property
 * access / call chain it roots. E.g. from "DateTime" in
 * `DateTime.now().plus({days:7}).toFormat('yyyy')`, climbs all the way to
 * the full chain expression — one usage site, not three.
 */
function climbToChainRoot(start: Node): Node {
  let node: Node = start;
  for (;;) {
    const parent = node.getParent();
    if (!parent) return node;
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
      node = parent;
      continue;
    }
    if (Node.isCallExpression(parent) && parent.getExpression() === node) {
      node = parent;
      continue;
    }
    if (Node.isNonNullExpression(parent) && parent.getExpression() === node) {
      node = parent;
      continue;
    }
    if (Node.isParenthesizedExpression(parent) && parent.getExpression() === node) {
      node = parent;
      continue;
    }
    return node;
  }
}

/** Is this reference the root of a property-access/call chain (vs. a plain read)? */
function isChainRoot(ref: Identifier): boolean {
  const parent = ref.getParent();
  if (!parent) return false;
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref) return true;
  if (Node.isCallExpression(parent) && parent.getExpression() === ref) return true;
  return false;
}

/** If topNode's value is assigned/reassigned to a variable, name that variable. */
function detectAssignedTo(topNode: Node): string | undefined {
  const parent = topNode.getParent();
  if (!parent) return undefined;
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === topNode) {
    const nameNode = parent.getNameNode();
    return Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
  }
  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getRight() === topNode
  ) {
    const left = parent.getLeft();
    return Node.isIdentifier(left) ? left.getText() : undefined;
  }
  return undefined;
}

/** The Identifier node representing the assignment target, for further ref-tracking. */
function getAssignedIdentifierNode(topNode: Node): Identifier | undefined {
  const parent = topNode.getParent();
  if (!parent) return undefined;
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === topNode) {
    const nameNode = parent.getNameNode();
    return Node.isIdentifier(nameNode) ? nameNode : undefined;
  }
  if (
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getRight() === topNode
  ) {
    const left = parent.getLeft();
    return Node.isIdentifier(left) ? left : undefined;
  }
  return undefined;
}

const RELATIONAL_OPERATORS = new Set(['<', '>', '<=', '>=', '===', '==', '!==', '!=']);

/** Lightweight, deterministic label for "the other side" of a comparison. */
function describeExpr(node: Node): string {
  const text = node.getText();
  if (/^new Date\s*\(/.test(text) || /^Date\.now\(\)$/.test(text)) return 'Date';
  return text.length <= 40 ? text : `${text.slice(0, 37)}...`;
}

/** Tag flows implied by a single reference's immediate syntactic context. */
function collectFlowFromUsageContext(node: Node, parent: Node, flows: FlowUse[]): void {
  if (Node.isBinaryExpression(parent)) {
    const op = parent.getOperatorToken().getText();
    if (RELATIONAL_OPERATORS.has(op)) {
      const other = parent.getLeft() === node ? parent.getRight() : parent.getLeft();
      flows.push(`compared-to:${describeExpr(other)}`);
    }
    return;
  }
  if (Node.isCallExpression(parent) && parent.getArguments().includes(node as any)) {
    const calleeText = parent.getExpression().getText();
    flows.push(`passed-to:${calleeText}`);
    if (calleeText === 'JSON.stringify') flows.push('serialized-to-json');
    return;
  }
  if (Node.isReturnStatement(parent)) {
    flows.push('returned');
    return;
  }
  if (Node.isArrowFunction(parent) && parent.getBody() === node) {
    flows.push('returned');
    return;
  }
  if (Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent)) {
    flows.push('stored-on-object');
    return;
  }
  if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
    flows.push(`chained-call:${parent.getName()}`);
    return;
  }
}

/** Follow a value-bearing identifier's other references in the file for flow signals. */
function collectFlowsForReferences(
  identifierNode: Identifier,
  sourceFile: SourceFile,
  excludeRange: Range,
  flows: FlowUse[],
): void {
  const refs = identifierNode.findReferencesAsNodes();
  for (const ref of refs) {
    if (ref.getSourceFile() !== sourceFile) continue;
    if (ref === identifierNode) continue;
    if (ref.getStart() >= excludeRange.start && ref.getEnd() <= excludeRange.end) continue;
    const parent = ref.getParent();
    if (!parent) continue;
    collectFlowFromUsageContext(ref, parent, flows);
  }
}

const TIMEZONE_HINT_PATTERN = /\.setZone\(|\.toUTC\(|\bzone\s*:/;

function analyzeFlow(topNode: Node, sourceFile: SourceFile): FlowUse[] {
  const flows: FlowUse[] = [];
  const range: Range = { start: topNode.getStart(), end: topNode.getEnd() };
  const parent = topNode.getParent();

  if (parent) {
    const assignedIdentifier = getAssignedIdentifierNode(topNode);
    if (assignedIdentifier) {
      collectFlowsForReferences(assignedIdentifier, sourceFile, range, flows);
    } else {
      collectFlowFromUsageContext(topNode, parent, flows);
    }
  }

  if (TIMEZONE_HINT_PATTERN.test(topNode.getText())) {
    flows.push('timezone-arg:present');
  }

  return Array.from(new Set(flows)).sort();
}

function hashId(file: string, range: Range): string {
  return createHash('sha1').update(`${file}:${range.start}-${range.end}`).digest('hex').slice(0, 12);
}

export function scanSourceFile(sourceFile: SourceFile): UsageSite[] {
  const filePath = sourceFile.getFilePath();
  const results: UsageSite[] = [];
  const seenRanges = new Set<string>();
  const seenDeclKeys = new Set<string>();
  const queue: Array<{ identifier: Identifier; library: SourceLibrary }> = [];

  for (const importDecl of sourceFile.getImportDeclarations()) {
    const library = matchLibrary(importDecl.getModuleSpecifierValue());
    if (!library) continue;
    for (const binding of getImportBindingNames(importDecl)) {
      const key = canonicalKeyFor(binding);
      if (seenDeclKeys.has(key)) continue;
      seenDeclKeys.add(key);
      queue.push({ identifier: binding, library });
    }
  }

  while (queue.length > 0) {
    const { identifier, library } = queue.shift()!;
    const refs = identifier.findReferencesAsNodes().filter((r) => r.getSourceFile() === sourceFile);

    for (const ref of refs) {
      if (!Node.isIdentifier(ref)) continue;
      if (!isChainRoot(ref)) continue;

      const topNode = climbToChainRoot(ref);
      const range: Range = { start: topNode.getStart(), end: topNode.getEnd() };
      const rangeKey = `${range.start}-${range.end}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);

      const assignedTo = detectAssignedTo(topNode);
      const flowContext = analyzeFlow(topNode, sourceFile);

      results.push({
        id: hashId(filePath, range),
        library,
        file: filePath,
        range,
        chainText: topNode.getText(),
        assignedTo,
        flowContext,
      });

      const assignedIdentifier = getAssignedIdentifierNode(topNode);
      if (assignedIdentifier) {
        const key = canonicalKeyFor(assignedIdentifier);
        if (!seenDeclKeys.has(key)) {
          seenDeclKeys.add(key);
          queue.push({ identifier: assignedIdentifier, library });
        }
      }
    }
  }

  results.sort((a, b) => a.range.start - b.range.start);
  return results;
}

export interface ScanProjectOptions {
  /** Directory to scan (glob-added as **\/*.{ts,tsx,js,jsx}, node_modules excluded). */
  rootDir?: string;
  /** Or point at an existing tsconfig.json for a real project. */
  tsConfigFilePath?: string;
}

export function buildProject(options: ScanProjectOptions): Project {
  if (options.tsConfigFilePath) {
    return new Project({ tsConfigFilePath: options.tsConfigFilePath });
  }
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      target: 9 /* ES2022 */,
    },
    skipAddingFilesFromTsConfig: true,
  });
  const rootDir = options.rootDir ?? '.';
  project.addSourceFilesAtPaths([
    `${rootDir}/**/*.{ts,tsx,js,jsx}`,
    `!${rootDir}/**/node_modules/**`,
  ]);
  return project;
}

export function scanProject(options: ScanProjectOptions): UsageSite[] {
  const project = buildProject(options);
  const sites: UsageSite[] = [];
  for (const sourceFile of project.getSourceFiles()) {
    sites.push(...scanSourceFile(sourceFile));
  }
  sites.sort((a, b) => (a.file === b.file ? a.range.start - b.range.start : a.file.localeCompare(b.file)));
  return sites;
}
