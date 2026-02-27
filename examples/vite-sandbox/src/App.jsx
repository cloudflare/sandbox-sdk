import { useEffect, useState } from "react";
import { Counter } from "./Counter";

const panelStyle = {
	flex: 1,
	display: "flex",
	flexDirection: "column",
	alignItems: "center",
	justifyContent: "center",
	gap: 16,
	padding: 24,
	boxSizing: "border-box",
};

const labelStyle = {
	fontSize: 18,
	color: "#888",
	margin: 0,
	textAlign: "center",
	maxWidth: 400,
};

const dividerStyle = {
	width: 1,
	background: "#333",
	flexShrink: 0,
};

export default function App() {
	const [sandboxUrl, setSandboxUrl] = useState(null);

	useEffect(() => {
		fetch("/api/sandbox")
			.then((r) => r.json())
			.then((data) => setSandboxUrl(data.url))
			.catch((err) => console.error(err));
	}, []);

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "row",
				height: "100dvh",
				fontFamily: "sans-serif",
				background: "#111",
				color: "#eee",
			}}
		>
			{/* Host panel */}
			<div style={panelStyle}>
				<p style={labelStyle}>
					This is the Host frame. The counter is incremented every second by hot
					module reloading.
				</p>
				<Counter />
			</div>

			<div style={dividerStyle} />

			{/* Sandbox panel */}
			<div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
				{sandboxUrl ? (
					<iframe
						key={sandboxUrl}
						title="Sandbox"
						src={sandboxUrl}
						style={{ flex: 1, border: "none", width: "100%" }}
					/>
				) : (
					<div style={panelStyle}>
						<p style={labelStyle}>Starting sandbox&hellip;</p>
					</div>
				)}
			</div>
		</div>
	);
}
