import { Counter } from "./Counter";

const panelStyle = {
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	gap: 16,
	height: "100dvh",
	padding: 24,
	boxSizing: "border-box",
	fontFamily: "sans-serif",
	background: "#111",
	color: "#eee",
};

const labelStyle = {
	fontSize: 18,
	color: "#888",
	margin: 0,
	textAlign: "center",
	maxWidth: 400,
};

export default function App() {
	return (
		<div style={panelStyle}>
			<p style={labelStyle}>
				This is the Sandbox frame. The counter is decremented every second by
				hot module reloading.
			</p>
			<Counter />
		</div>
	);
}
