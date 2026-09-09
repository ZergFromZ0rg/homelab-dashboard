import { useState } from "react";

function newItem(text) {
  return {
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `t${Date.now()}${Math.random().toString(16).slice(2)}`,
    text,
    done: false,
    created_at: Date.now() / 1000,
  };
}

function TodoList({ todos, onChange }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(null); // { id, text }
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    onChange([...todos, newItem(text)]);
    setDraft("");
  };

  const patch = (id, fields) =>
    onChange(todos.map((t) => (t.id === id ? { ...t, ...fields } : t)));

  const remove = (id) => onChange(todos.filter((t) => t.id !== id));

  const commitEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text) patch(editing.id, { text });
    else remove(editing.id);
    setEditing(null);
  };

  const drop = (target) => {
    if (dragIndex == null || dragIndex === target) return;
    const next = [...todos];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <div className="todo-list">
      <div className="todo-add">
        <input
          type="text"
          value={draft}
          placeholder="Add a task…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button type="button" onClick={add} disabled={!draft.trim()}>
          Add
        </button>
      </div>

      {todos.length === 0 ? (
        <p className="overview-empty">No tasks yet.</p>
      ) : (
        <ul>
          {todos.map((item, i) => {
            const isEditing = editing?.id === item.id;
            return (
              <li
                key={item.id}
                className={`todo-item ${item.done ? "todo-item--done" : ""} ${
                  overIndex === i && dragIndex !== i ? "todo-item--over" : ""
                }`}
                draggable={!isEditing}
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverIndex(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(i);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
              >
                <span className="todo-grip" aria-hidden="true">
                  ⠿
                </span>

                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={(e) => patch(item.id, { done: e.target.checked })}
                />

                {isEditing ? (
                  <input
                    className="todo-edit"
                    type="text"
                    value={editing.text}
                    autoFocus
                    onChange={(e) =>
                      setEditing({ ...editing, text: e.target.value })
                    }
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span
                    className="todo-text"
                    onClick={() => setEditing({ id: item.id, text: item.text })}
                  >
                    {item.text}
                  </span>
                )}

                <button
                  type="button"
                  className="todo-remove"
                  title="Delete"
                  onClick={() => remove(item.id)}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default TodoList;
