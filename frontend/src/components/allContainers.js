// {host: [container]} -> one flat list, each container carrying its host.
export function allContainers(containers) {
  return Object.entries(containers).flatMap(([host, list]) => list.map((c) => ({ host, ...c })));
}
