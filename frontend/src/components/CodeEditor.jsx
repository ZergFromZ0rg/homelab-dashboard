import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { StreamLanguage } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";

// The config editor. Lazy-loaded by FileViewer — CodeMirror only arrives
// when someone opens a text file, and each language only when a file of
// that kind does. Languages cover what a homelab edits: compose YAML, .env,
// JSON, shell, TOML, nginx, Dockerfiles, Python.

const legacy = (load) => () => load().then((mode) => StreamLanguage.define(mode));

function languageLoader(name) {
  const lower = name.toLowerCase();
  if (/\.(ya?ml)$/.test(lower)) return () => import("@codemirror/lang-yaml").then((m) => m.yaml());
  if (/\.json5?$/.test(lower)) return () => import("@codemirror/lang-json").then((m) => m.json());
  if (/\.(m?[jt]sx?)$/.test(lower)) {
    return () =>
      import("@codemirror/lang-javascript").then((m) =>
        m.javascript({ jsx: true, typescript: /\.tsx?$/.test(lower) })
      );
  }
  if (lower.endsWith(".py")) return () => import("@codemirror/lang-python").then((m) => m.python());
  if (/\.(md|markdown)$/.test(lower)) return () => import("@codemirror/lang-markdown").then((m) => m.markdown());
  if (/\.(sh|bash|zsh)$/.test(lower) || /^\.?(bash|zsh)rc$|^\.profile$/.test(lower)) {
    return legacy(() => import("@codemirror/legacy-modes/mode/shell").then((m) => m.shell));
  }
  if (lower.endsWith(".toml")) return legacy(() => import("@codemirror/legacy-modes/mode/toml").then((m) => m.toml));
  if (lower.endsWith(".conf") && lower.includes("nginx")) {
    return legacy(() => import("@codemirror/legacy-modes/mode/nginx").then((m) => m.nginx));
  }
  if (lower === "dockerfile" || lower.endsWith(".dockerfile")) {
    return legacy(() => import("@codemirror/legacy-modes/mode/dockerfile").then((m) => m.dockerFile));
  }
  if (/(^|\.)env(\..*)?$|\.(ini|properties|cfg|conf)$/.test(lower)) {
    return legacy(() => import("@codemirror/legacy-modes/mode/properties").then((m) => m.properties));
  }
  return null;
}

function CodeEditor({ name, initial, readOnly, onChange, onSave }) {
  const holder = useRef(null);
  const handlers = useRef({ onChange, onSave });
  // The text it starts with, read once: the parent remounts it (by key)
  // when the file is reloaded, and a save must not rebuild it.
  const startText = useRef(initial);

  useEffect(() => {
    handlers.current = { onChange, onSave };
  }, [onChange, onSave]);

  useEffect(() => {
    const language = new Compartment();
    const view = new EditorView({
      parent: holder.current,
      state: EditorState.create({
        doc: startText.current,
        extensions: [
          basicSetup,
          oneDark,
          language.of([]),
          EditorState.readOnly.of(readOnly),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: (v) => {
                handlers.current.onSave?.(v.state.doc.toString());
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange?.(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%", fontSize: "13px" },
            ".cm-scroller": { fontFamily: "var(--mono)" },
          }),
        ],
      }),
    });
    view.focus();

    let live = true;
    languageLoader(name)?.()
      .then((extension) => live && view.dispatch({ effects: language.reconfigure(extension) }))
      .catch(() => {}); // highlighting is a nicety; plain text is fine
    return () => {
      live = false;
      view.destroy();
    };
  }, [name, readOnly]);

  return <div className="fx-editor" ref={holder} />;
}

export default CodeEditor;
