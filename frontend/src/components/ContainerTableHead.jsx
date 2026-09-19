// Column labels for a group of ContainerRow lines; the grid template lives
// in CSS (.crow-line / .crow-head) so header and rows can't drift apart.
function ContainerTableHead() {
  return (
    <div className="crow-head" role="presentation">
      <span />
      <span>Container</span>
      <span>Status</span>
      <span>CPU</span>
      <span>Memory</span>
      <span>Network</span>
      <span className="crow-head-uptime">Uptime</span>
      <span />
    </div>
  );
}

export default ContainerTableHead;
