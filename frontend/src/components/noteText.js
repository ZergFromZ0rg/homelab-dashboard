// How a note shows up in the list: its first line is the title, its second
// non-empty line a preview.

function lines(body) {
  return body.split("\n").map((l) => l.trim()).filter(Boolean);
}

export function noteTitle(body) {
  const first = lines(body)[0];
  if (!first) return "Untitled note";
  return first.length > 70 ? `${first.slice(0, 67)}…` : first;
}

export function notePreview(body) {
  const second = lines(body)[1];
  if (!second) return "";
  return second.length > 110 ? `${second.slice(0, 107)}…` : second;
}
