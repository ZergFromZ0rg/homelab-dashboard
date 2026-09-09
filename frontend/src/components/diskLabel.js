// Human label for a filesystem row: "System" for the root mount, the raw
// mountpoint otherwise.
export function diskLabel(filesystem) {
  return filesystem.mountpoint === "/" ? "System" : filesystem.mountpoint;
}
