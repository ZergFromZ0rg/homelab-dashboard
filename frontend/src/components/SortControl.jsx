import { SORT_OPTIONS } from "./containerSort";

function SortControl({ value, onChange }) {
  return (
    <label className="sort-control">
      <span>Sort containers</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default SortControl;
