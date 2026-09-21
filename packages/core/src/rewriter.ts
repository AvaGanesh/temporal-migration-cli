/**
 * Module 4 — Rewriter.
 *
 * Consumes the Adapter's RewriteRule/ManualReviewFlag decisions (Module 3)
 * and actually mutates a ts-morph AST, emitting a unified diff per file.
 * Never writes to disk — callers decide whether/how to apply the result.
 *
 * Safety behaviors (per the plan):
 *  - AMBIGUOUS/low-confidence classifications never reach the adapter; they
 *    become manual-review flags directly, before any AST work happens.
 *  - A file with zero applied rewrites gets no FileDiff entry at all.
 *  - Replacements within one file are applied right-to-left (by range start,
 *    descending), so earlier positions in the same file stay valid as later
 *    ones are rewritten — no stale-offset bugs from a forward pass.
 */
import { createTwoFilesPatch } from 'diff';
import { Identifier, Node, SourceFile } from 'ts-morph';
import { buildProject, type ScanProjectOptions } from './scanner.js';
import type {
  CallChainLink,
  Classification,
  FileDiff,
  LibraryAdapter,
  ManualReviewFlag,
  ParsedCallChain,
  Range,
  RewriteResult,
  RewriteRule,
  SourceLibrary,
  UsageSite,
} from './types.js';

/** Re-locate the exact node a UsageSite's range points to, by climbing from the innermost match. */
function findNodeByRange(sourceFile: SourceFile, range: Range): Node | undefined {
  let node: Node | undefined = sourceFile.getDescendantAtPos(range.start);
  while (node && !(node.getStart() === range.start && node.getEnd() === range.end)) {
    node = node.getParent();
  }
  return node;
}

/** Decompose a chain-root node (as produced by the Scanner) into a flat, ts-morph-free link list. */
export function parseCallChain(usageSiteId: string, node: Node): ParsedCallChain {
  const links: CallChainLink[] = [];
  let current: Node = node;

  for (;;) {
    if (Node.isCallExpression(current)) {
      const args = current.getArguments().map((a) => a.getText());
      const callee = current.getExpression();
      if (Node.isPropertyAccessExpression(callee)) {
        links.unshift({ method: callee.getName(), args });
        current = callee.getExpression();
        continue;
      }
      links.unshift({ method: '', args });
      current = callee;
      continue;
    }
    if (Node.isPropertyAccessExpression(current)) {
      links.unshift({ method: current.getName(), args: [] });
      current = current.getExpression();
      continue;
    }
    break;
  }

  return { usageSiteId, rootText: current.getText(), links };
}

function identifierStillReferenced(sourceFile: SourceFile, id: Identifier | undefined): boolean {
  if (!id) return false;
  return id.findReferencesAsNodes().some((r) => r.getSourceFile() === sourceFile && r !== id);
}

/** Remove the source-library import if unused post-rewrite; add the Temporal import if needed. */
function manageImports(
  sourceFile: SourceFile,
  library: SourceLibrary,
  needsTemporalImport: boolean,
): void {
  for (const importDecl of sourceFile.getImportDeclarations()) {
    if (importDecl.getModuleSpecifierValue() !== library) continue;

    const bindings: Array<Identifier | undefined> = [
      importDecl.getDefaultImport(),
      importDecl.getNamespaceImport(),
      ...importDecl.getNamedImports().map((named) => {
        const local = named.getAliasNode() ?? named.getNameNode();
        return Node.isIdentifier(local) ? local : undefined;
      }),
    ];

    const stillUsed = bindings.some((b) => identifierStillReferenced(sourceFile, b));
    if (!stillUsed) importDecl.remove();
  }

  if (needsTemporalImport) {
    const hasTemporalImport = sourceFile
      .getImportDeclarations()
      .some((d) => d.getModuleSpecifierValue() === 'temporal-polyfill');
    if (!hasTemporalImport) {
      sourceFile.insertImportDeclaration(0, {
        moduleSpecifier: 'temporal-polyfill',
        namedImports: ['Temporal'],
      });
    }
  }
}

export interface RunRewriterOptions extends ScanProjectOptions {
  sites: UsageSite[];
  classifications: Classification[];
  adapter: LibraryAdapter;
}

export function runRewriter(options: RunRewriterOptions): RewriteResult {
  const { sites, classifications, adapter, ...scanOptions } = options;
  const project = buildProject(scanOptions);
  const classificationById = new Map(classifications.map((c) => [c.usageSiteId, c]));

  const manualReviewFlags: ManualReviewFlag[] = [];
  const rulesByFile = new Map<string, Array<{ site: UsageSite; rule: RewriteRule }>>();

  for (const site of sites) {
    const classification = classificationById.get(site.id);
    if (!classification || classification.guess === 'AMBIGUOUS') {
      manualReviewFlags.push({
        type: 'manual-review',
        usageSiteId: site.id,
        reason: classification?.reason ?? 'no classification available for this usage site',
      });
      continue;
    }

    const sourceFile = project.getSourceFileOrThrow(site.file);
    const node = findNodeByRange(sourceFile, site.range);
    if (!node) {
      manualReviewFlags.push({
        type: 'manual-review',
        usageSiteId: site.id,
        reason: 'could not re-locate this usage site in the AST for rewriting',
      });
      continue;
    }

    const chain = parseCallChain(site.id, node);
    const mapped = adapter.mapUsageSite(chain, classification);
    if (mapped.type === 'manual-review') {
      manualReviewFlags.push(mapped);
      continue;
    }

    const list = rulesByFile.get(site.file) ?? [];
    list.push({ site, rule: mapped });
    rulesByFile.set(site.file, list);
  }

  const fileDiffs: FileDiff[] = [];
  for (const [file, entries] of rulesByFile) {
    const sourceFile = project.getSourceFileOrThrow(file);
    const originalText = sourceFile.getFullText();

    // Right-to-left: replacing a node never shifts the positions of nodes
    // that start earlier in the same file, so stored ranges stay valid.
    const sorted = [...entries].sort((a, b) => b.site.range.start - a.site.range.start);
    for (const { site, rule } of sorted) {
      const node = findNodeByRange(sourceFile, site.range);
      if (!node) continue;
      node.replaceWithText(rule.newText);
    }

    const needsTemporalImport = entries.some((e) => e.rule.requiresTemporalImport);
    manageImports(sourceFile, adapter.libraryName, needsTemporalImport);

    const newText = sourceFile.getFullText();
    const diff = createTwoFilesPatch(file, file, originalText, newText, '', '');
    fileDiffs.push({ file, diff, rewrittenSiteIds: entries.map((e) => e.site.id) });
  }

  return { fileDiffs, manualReviewFlags };
}
