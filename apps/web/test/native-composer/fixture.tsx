import type { Editor } from "@tiptap/core";
import { createRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../../src/components/ComposerPromptEditor";
import "../../src/index.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
let generation = 0;
let events: ReturnType<typeof snapshot>[] = [];
let frames: string[] = [];
let recording = false;

function editor() {
  const element = document.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount");
  return element.editor;
}

function snapshot() {
  const instance = editor();
  return {
    text: instance.state.doc.textContent,
    from: instance.state.selection.from,
    to: instance.state.selection.to,
    composing: instance.view.composing,
    selected: instance.state.doc.textBetween(
      instance.state.selection.from,
      instance.state.selection.to,
    ),
  };
}

function frame() {
  if (!recording) return;
  frames.push(snapshot().text);
  requestAnimationFrame(frame);
}

const nativeComposer = {
  mount(text: string, selected: boolean, richTextEnabled: boolean) {
    recording = false;
    flushSync(() =>
      root.render(
        <ComposerPromptEditor
          key={++generation}
          editorRef={createRef<ComposerPromptEditorHandle>()}
          value={text}
          cursor={text.length}
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
    const instance = editor();
    instance.commands.focus();
    if (selected) instance.commands.setTextSelection({ from: 1, to: text.length + 1 });
    events = [];
    frames = [];
    instance.on("transaction", () => events.push(snapshot()));
    recording = true;
    requestAnimationFrame(frame);
    return snapshot();
  },
  snapshot,
  evidence() {
    recording = false;
    return { events, frames, final: snapshot() };
  },
  undo() {
    editor().commands.undo();
    return snapshot();
  },
  redo() {
    editor().commands.redo();
    return snapshot();
  },
};

const keyboardEvents: object[] = [];
for (const type of [
  "keydown",
  "keyup",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "beforeinput",
  "input",
]) {
  document.addEventListener(
    type,
    (event) => {
      const detail =
        event instanceof KeyboardEvent
          ? { key: event.key, code: event.code, isComposing: event.isComposing }
          : event instanceof CompositionEvent || event instanceof InputEvent
            ? { data: event.data }
            : {};
      keyboardEvents.push({
        type,
        trusted: event.isTrusted,
        target: event.target instanceof HTMLElement ? event.target.id : "",
        ...detail,
      });
    },
    true,
  );
}

Object.assign(window, { nativeComposer, keyboardEvents });
