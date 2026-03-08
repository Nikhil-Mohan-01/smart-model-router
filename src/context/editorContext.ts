import * as vscode from 'vscode';
import { estimateTokens } from '../utils/tokenEstimator';

const MAX_CONTEXT_TOKENS = 2000;
const VISIBLE_LINE_PADDING = 20;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getOpenFiles(): string[] {
  return vscode.workspace.textDocuments
    .filter((doc) => !doc.isClosed && !doc.isUntitled)
    .map((doc) => doc.uri.fsPath)
    .slice(0, 50);
}

function buildContextXml(
  filePath: string,
  languageId: string,
  selection: string,
  visibleCode: string,
  openFiles: string[]
): string {
  return [
    '<context>',
    `<file>${escapeXml(filePath)}</file>`,
    `<language>${escapeXml(languageId)}</language>`,
    `<selection>${escapeXml(selection)}</selection>`,
    `<visible_code>${escapeXml(visibleCode)}</visible_code>`,
    `<open_files>${escapeXml(openFiles.join('\n'))}</open_files>`,
    '</context>',
  ].join('\n');
}

export function getEditorContext(): string {
  const editor = vscode.window.activeTextEditor;
  const openFiles = getOpenFiles();

  if (!editor) {
    return buildContextXml('', '', '', '', openFiles);
  }

  const doc = editor.document;
  const selectionText = editor.selection.isEmpty
    ? ''
    : doc.getText(editor.selection);

  const cursor = editor.selection.active.line;
  const startLine = Math.max(0, cursor - VISIBLE_LINE_PADDING);
  const endLine = Math.min(doc.lineCount - 1, cursor + VISIBLE_LINE_PADDING);
  const visibleRange = new vscode.Range(
    startLine,
    0,
    endLine,
    doc.lineAt(endLine).text.length
  );

  let visibleCode = doc.getText(visibleRange);
  let xml = buildContextXml(doc.uri.fsPath, doc.languageId, selectionText, visibleCode, openFiles);

  // Keep total context overhead bounded by trimming visible code first.
  while (estimateTokens(xml) > MAX_CONTEXT_TOKENS && visibleCode.length > 0) {
    visibleCode = visibleCode.slice(0, Math.floor(visibleCode.length * 0.85));
    xml = buildContextXml(doc.uri.fsPath, doc.languageId, selectionText, visibleCode, openFiles);
  }

  return xml;
}
