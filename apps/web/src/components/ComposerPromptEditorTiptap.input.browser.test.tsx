import type { Editor } from "@tiptap/core";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountEditor(value: string, richTextEnabled: boolean) {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
        richTextEnabled={richTextEnabled}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function insertText(editor: Editor, from: number, to: number, text: string) {
  const insert = () => {
    const tr = editor.state.tr.insertText(text, from, to);
    return editor.view.composing ? tr.setMeta("composition", 1) : tr;
  };
  if (
    !editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, text, insert),
    )
  ) {
    editor.view.dispatch(insert());
  }
}

it.each([true, false])(
  "replaces a dead-key accent without surrounding it when rich text is %s",
  async (richTextEnabled) => {
    const editor = await mountEditor("we´", richTextEnabled);
    await act(async () => {
      expect(editor.state.selection.empty).toBe(true);
      insertText(editor, 3, 4, "'");
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("we'");
    expect(editor.state.selection.from).toBe(4);
    expect(editor.state.selection.empty).toBe(true);
  },
);

it("still surrounds selected text with quotes", async () => {
  const editor = await mountEditor("word", true);
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    insertText(editor, 1, 5, "'");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("'word'");
  expect(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)).toBe(
    "word",
  );
});

it.each([
  { quote: "'", richTextEnabled: true, key: "Dead" },
  { quote: '"', richTextEnabled: true, key: "Dead" },
  { quote: "'", richTextEnabled: false, key: "Dead" },
  { quote: "'", richTextEnabled: true, key: "Process" },
  { quote: '"', richTextEnabled: true, key: "Process" },
])(
  "surrounds the original selection after dead-key composition: %j",
  async ({ quote, richTextEnabled, key }) => {
    const editor = await mountEditor("before word after", richTextEnabled);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      editor.commands.setTextSelection({ from: 8, to: 12 });
      editor.view.dom.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: "Quote",
          keyCode: key === "Process" ? 229 : 222,
          bubbles: true,
        }),
      );
      expect(editor.state.selection.empty).toBe(true);
      editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true, data: "word" }),
      );
      editor.view.dispatch(
        editor.state.tr.insertText(quote === "'" ? "´" : "¨").setMeta("composition", 1),
      );
      expect(editor.state.doc.textContent).toBe(`before ${quote === "'" ? "´" : "¨"}word after`);
      insertText(editor, 8, 9, quote);
      expect(editor.state.doc.textContent).toBe(`before ${quote}word after`);
      editor.view.dom.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: quote }),
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`before ${quote}word${quote} after`);
    expect(
      editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to),
    ).toBe("word");
    await act(async () => {
      editor.commands.undo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe("before word after");
    await act(async () => {
      editor.commands.redo();
    });
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`before ${quote}word${quote} after`);
  },
);

it("lets an accented letter replace the selection", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    insertText(editor, 1, 2, "é");
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "é" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    insertText(editor, 2, 2, "'");
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("é'");
  expect(editor.state.selection.empty).toBe(true);
});

it("does not restore a composition selection after the draft is replaced", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText("'").setMeta("composition", 1));
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "'" }),
    );
    editor.commands.setContent("new draft");
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("new draft");
});

it("keeps the original selection when dead-key composition is cancelled", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    insertText(editor, 1, 2, "");
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "" }),
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("word");
  expect(editor.state.selection.from).toBe(1);
  expect(editor.state.selection.to).toBe(5);
});

it("leaves other input methods free to replace selected text during composition", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.setTextSelection({ from: 1, to: 5 });
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.view.dispatch(editor.state.tr.insertText("字").setMeta("composition", 1));
    expect(editor.state.doc.textContent).toBe("字");
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "字" }),
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("字");
});

it("keeps select-all text in place while a dead key resolves", async () => {
  const editor = await mountEditor("word", true);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(async () => {
    editor.commands.selectAll();
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Dead", bubbles: true }));
    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(editor.state.selection.from).toBe(1);
    editor.view.dispatch(editor.state.tr.insertText("´").setMeta("composition", 1));
    expect(editor.state.doc.textContent).toBe("´word");
    insertText(editor, 1, 2, "'");
    editor.view.dom.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "'" }),
    );
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(serializeEditorDoc(editor.state.doc).value).toBe("'word'");
});
