// Server history (machine sparklines, GPU temp) covers a fixed window —
// trimming to a shorter one the user picked in Settings is just a client
// side slice by timestamp, no re-query needed.
export function windowPoints(points, minutes) {
  if (!points || !minutes) return points || [];
  const cutoff = Date.now() / 1000 - minutes * 60;
  return points.filter((p) => p.t == null || p.t >= cutoff);
}
