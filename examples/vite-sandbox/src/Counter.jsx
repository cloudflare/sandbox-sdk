import { count } from "./value.js";

const countStyle = {
	fontSize: 96,
	fontWeight: 700,
	margin: 0,
	lineHeight: 1,
	color: "#eee",
};

export function Counter() {
	return <p style={countStyle}>{count}</p>;
}
