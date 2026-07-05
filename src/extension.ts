import * as vscode from "vscode";

let followEnabled = false;
let isSyncing = false;
let lastFollowDocumentUri: string | undefined;
/** Ignore visible-range echo from programmatic revealRange (VS Code may emit several). */
const ignoredScrollUntil = new WeakMap<vscode.TextEditor, number>();
const IGNORE_PROGRAMMATIC_SCROLL_MS = 200;

/** Suppress scroll sync briefly after edits; content changes also update visible ranges. */
const editScrollSuppression = new Map<
  string,
  { version: number; timer: ReturnType<typeof setTimeout> }
>();

function noteDocumentEdit(document: vscode.TextDocument): void {
  const uri = document.uri.toString();
  const existing = editScrollSuppression.get(uri);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => editScrollSuppression.delete(uri), 100);
  editScrollSuppression.set(uri, { version: document.version, timer });
}

function isEditInducedVisibleRangeChange(editor: vscode.TextEditor): boolean {
  const entry = editScrollSuppression.get(editor.document.uri.toString());
  return entry !== undefined && entry.version === editor.document.version;
}

function markIgnoredScroll(editor: vscode.TextEditor): void {
  ignoredScrollUntil.set(editor, Date.now() + IGNORE_PROGRAMMATIC_SCROLL_MS);
}

function isIgnoredScroll(editor: vscode.TextEditor): boolean {
  const until = ignoredScrollUntil.get(editor);
  if (until === undefined) {
    return false;
  }
  if (Date.now() >= until) {
    ignoredScrollUntil.delete(editor);
    return false;
  }
  return true;
}

function sameDocument(
  a: vscode.TextEditor,
  b: vscode.TextEditor
): boolean {
  return a.document.uri.toString() === b.document.uri.toString();
}

function followers(leader: vscode.TextEditor): vscode.TextEditor[] {
  return vscode.window.visibleTextEditors.filter(
    (e) => e !== leader && sameDocument(e, leader)
  );
}

function isFollowableDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" || document.uri.scheme === "untitled";
}

function firstVisibleLineInclusive(editor: vscode.TextEditor): number | undefined {
  let min = Number.POSITIVE_INFINITY;

  for (const range of editor.visibleRanges) {
    min = Math.min(min, range.start.line);
  }

  return Number.isFinite(min) ? min : undefined;
}

function lastVisibleLineInclusive(editor: vscode.TextEditor): number | undefined {
  let max = -1;

  for (const range of editor.visibleRanges) {
    const line =
      range.end.character === 0 ? range.end.line - 1 : range.end.line;
    if (line >= range.start.line) {
      max = Math.max(max, line);
    }
  }

  return max >= 0 ? max : undefined;
}

const FOLLOWER_LINE_OFFSET = 25;

function isScrolledToEnd(editor: vscode.TextEditor): boolean {
  const lastVisible = lastVisibleLineInclusive(editor);
  const lastLine = editor.document.lineCount - 1;

  return lastVisible !== undefined && lastVisible >= lastLine;
}

function continuationLine(editor: vscode.TextEditor): number | undefined {
  const lastVisible = lastVisibleLineInclusive(editor);
  if (lastVisible === undefined) {
    return undefined;
  }

  const targetLine = lastVisible + 1 + FOLLOWER_LINE_OFFSET;
  const lastLine = editor.document.lineCount - 1;
  return Math.min(targetLine, lastLine);
}

function mirrorScroll(source: vscode.TextEditor, target: vscode.TextEditor): void {
  const firstVisible = firstVisibleLineInclusive(source);
  if (firstVisible === undefined) {
    return;
  }

  const pos = new vscode.Position(firstVisible, 0);
  markIgnoredScroll(target);
  target.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.AtTop
  );
}

function syncScrollWithOffset(leader: vscode.TextEditor): void {
  const others = followers(leader);
  if (others.length === 0) {
    return;
  }

  isSyncing = true;
  try {
    let source = leader;
    for (const editor of others) {
      if (isScrolledToEnd(source)) {
        mirrorScroll(source, editor);
      } else {
        const line = continuationLine(source);
        if (line === undefined) {
          break;
        }

        const pos = new vscode.Position(line, 0);
        markIgnoredScroll(editor);
        editor.revealRange(
          new vscode.Range(pos, pos),
          vscode.TextEditorRevealType.AtTop
        );
      }
      source = editor;
    }
  } finally {
    isSyncing = false;
  }
}

async function closeExtraPanes(leader: vscode.TextEditor): Promise<void> {
  const groups = vscode.window.tabGroups.all;
  if (groups.length <= 1) {
    return;
  }

  await vscode.window.showTextDocument(leader.document, {
    viewColumn: leader.viewColumn,
    preserveFocus: true,
  });

  const keepColumn =
    leader.viewColumn ?? vscode.window.tabGroups.activeTabGroup.viewColumn;
  const toClose = groups.filter((g) => g.viewColumn !== keepColumn);
  if (toClose.length > 0) {
    await vscode.window.tabGroups.close(toClose, true);
  }
}

async function ensureFollowerPane(leader: vscode.TextEditor): Promise<void> {
  if (!isFollowableDocument(leader.document)) {
    return;
  }
  if (followers(leader).length > 0) {
    return;
  }

  const editor = await vscode.window.showTextDocument(leader.document, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
  });
  markIgnoredScroll(editor);
}

async function setupFollowLayout(leader: vscode.TextEditor | undefined): Promise<void> {
  if (!leader || !followEnabled || isSyncing) {
    return;
  }
  if (!isFollowableDocument(leader.document)) {
    return;
  }

  const documentUri = leader.document.uri.toString();
  const isNewFile = documentUri !== lastFollowDocumentUri;

  isSyncing = true;
  try {
    if (isNewFile) {
      await closeExtraPanes(leader);
      lastFollowDocumentUri = documentUri;
    }
    await ensureFollowerPane(leader);
    if (isNewFile) {
      markIgnoredScroll(leader);
    }
    syncScrollWithOffset(leader);
  } finally {
    isSyncing = false;
  }
}

function promoteToLeader(editor: vscode.TextEditor): void {
  if (!followEnabled || isSyncing || isIgnoredScroll(editor)) {
    return;
  }
  if (!isFollowableDocument(editor.document)) {
    return;
  }
  syncScrollWithOffset(editor);
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("followMode.toggle", async () => {
      followEnabled = !followEnabled;
      vscode.window.showInformationMessage(
        followEnabled ? "Follow mode ON" : "Follow mode OFF"
      );
      lastFollowDocumentUri = undefined;
      if (followEnabled) {
        await setupFollowLayout(vscode.window.activeTextEditor);
      }
    }),

    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!followEnabled || isSyncing) {
        return;
      }
      void setupFollowLayout(editor);
    }),

    vscode.workspace.onDidChangeTextDocument((event) => {
      if (!followEnabled || !isFollowableDocument(event.document)) {
        return;
      }
      noteDocumentEdit(event.document);
    }),

    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      if (isEditInducedVisibleRangeChange(event.textEditor)) {
        return;
      }
      promoteToLeader(event.textEditor);
    }),

    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (!followEnabled || isSyncing || isIgnoredScroll(event.textEditor)) {
        return;
      }
      if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
        return;
      }
      promoteToLeader(event.textEditor);
    })
  );
}
