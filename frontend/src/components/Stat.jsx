// One labelled stat cell: an uppercase label over a value, with room for
// extras (a mini-bar, a sparkline, `<small>` suffixes). Repeated ~20 times
// across ContainerRow and MachineVitals; the surrounding grid/flex and the
// label/value typography come from the parent's CSS
// (.container-stats-grid, .network-stats, .gpu-stats, ...), which targets
// the plain `div > span`/`strong` this renders.
function Stat({ label, value, children }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
      {children}
    </div>
  );
}

export default Stat;
